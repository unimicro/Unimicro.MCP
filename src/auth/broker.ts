import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { OAuthMetadata } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import { ClientRegistry } from './clients.js';
import { TtlStore } from './store.js';

/**
 * An OAuth 2.1 authorization server that is really a translator.
 *
 * MCP clients expect to register themselves and then run a plain PKCE
 * authorization code flow. Unimicro's identity provider allows neither: apps
 * are registered by hand in the developer portal, and their callback URLs are
 * fixed at registration time.
 *
 * So this server stands in the middle. Downstream it is a public-client
 * authorization server that any MCP client can talk to. Upstream it is your
 * one registered client — confidential or public — with one fixed callback. The two
 * halves are stitched together by a short-lived transaction record.
 *
 *     MCP client ──▶ /oauth/authorize ──▶ <UNIMICRO_ISSUER>/connect/authorize
 *                                                      │
 *     MCP client ◀── /oauth/callback  ◀─────────────────┘
 *     MCP client ──▶ /oauth/token     ──▶ <UNIMICRO_ISSUER>/connect/token
 *
 * The access token handed back is Unimicro's own, unmodified — this server
 * mints no tokens of its own. See docs/AUTH.md for why, and what that costs.
 */

/** A login that has left for Unimicro and not yet come back. */
interface LoginTransaction {
    clientId: string;
    clientRedirectUri: string;
    clientState: string | undefined;
    /** The MCP client's PKCE challenge, checked when it redeems its code. */
    clientCodeChallenge: string;
    /** Our own PKCE verifier for the upstream leg. */
    upstreamCodeVerifier: string;
    scope: string;
}

/** An authorization code we issued, waiting to be exchanged. */
interface IssuedCode {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    tokens: UpstreamTokens;
}

interface UpstreamTokens {
    access_token: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    id_token?: string;
}

const LOGIN_TTL_MS = 5 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;

export function createAuthBroker(config: Config) {
    const logins = new TtlStore<LoginTransaction>(LOGIN_TTL_MS);
    const codes = new TtlStore<IssuedCode>(CODE_TTL_MS);
    const clients = new ClientRegistry();

    const upstreamAuthorize = new URL('/connect/authorize', config.issuer);
    const upstreamToken = new URL('/connect/token', config.issuer);
    const callbackUri = new URL('/oauth/callback', config.publicUrl).toString();

    const router = Router();

    // ── Dynamic Client Registration (RFC 7591) ──────────────────────────────
    // Deprecated by MCP 2026-07-28 in favour of Client ID Metadata Documents,
    // which need no endpoint at all. Kept for clients that still use it.
    router.post('/oauth/register', (req: Request, res: Response) => {
        const body = req.body as Record<string, unknown> | undefined;
        const redirectUris = Array.isArray(body?.redirect_uris)
            ? body.redirect_uris.filter((u): u is string => typeof u === 'string' && u.length > 0)
            : [];

        if (redirectUris.length === 0) {
            res.status(400).json({
                error: 'invalid_client_metadata',
                error_description: 'redirect_uris must be a non-empty array of strings.',
            });
            return;
        }

        const registration = clients.register(redirectUris);
        res.status(201).json({
            client_id: registration.clientId,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            redirect_uris: registration.redirectUris,
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            scope: config.scopes.join(' '),
        });
    });

    // ── Authorization request ───────────────────────────────────────────────
    router.get('/oauth/authorize', async (req: Request, res: Response) => {
        const q = query(req);
        const clientId = q.client_id;
        const redirectUri = q.redirect_uri;

        if (!clientId || !redirectUri) {
            fail(res, 'client_id and redirect_uri are required.');
            return;
        }

        // Until the redirect URI is proven to belong to the client, an error
        // redirect would itself be an open redirect. Render errors instead.
        const registration = await clients.resolve(clientId).catch(() => undefined);
        if (!registration) {
            fail(res, `Unknown client_id "${clientId}". Register at /oauth/register, or use an HTTPS client-ID metadata document URL.`);
            return;
        }
        if (!registration.redirectUris.includes(redirectUri)) {
            fail(res, 'redirect_uri does not match any URI registered for this client.');
            return;
        }

        // From here the redirect URI is trusted, so failures go back to the client.
        const back = (error: string, description: string) =>
            res.redirect(302, buildRedirect(redirectUri, { error, error_description: description, state: q.state, iss: config.publicUrl.origin }));

        if (q.response_type !== 'code') {
            back('unsupported_response_type', 'Only response_type=code is supported.');
            return;
        }
        if (!q.code_challenge || q.code_challenge_method !== 'S256') {
            back('invalid_request', 'PKCE is required: send code_challenge with code_challenge_method=S256.');
            return;
        }
        // RFC 8707. Clients must name the resource the token is for; if they
        // name someone else's, refuse rather than mint a token for the wrong ear.
        if (q.resource && !resourceMatches(q.resource, config.resourceUrl)) {
            back('invalid_target', `This server only issues tokens for ${config.resourceUrl.href}.`);
            return;
        }

        const upstreamCodeVerifier = base64url(randomBytes(32));
        const state = base64url(randomBytes(32));
        const scope = requestedScope(q.scope, config.scopes);

        logins.set(state, {
            clientId,
            clientRedirectUri: redirectUri,
            clientState: q.state,
            clientCodeChallenge: q.code_challenge,
            upstreamCodeVerifier,
            scope,
        });

        res.redirect(302, buildRedirect(upstreamAuthorize.toString(), {
            client_id: config.clientId,
            redirect_uri: callbackUri,
            response_type: 'code',
            scope,
            state,
            code_challenge: pkceChallenge(upstreamCodeVerifier),
            code_challenge_method: 'S256',
        }));
    });

    // ── Callback from Unimicro ──────────────────────────────────────────────
    router.get('/oauth/callback', async (req: Request, res: Response) => {
        const q = query(req);
        const state = q.state;

        // Single-use: taking the transaction is what stops a replayed callback.
        const login = state ? logins.take(state) : undefined;
        if (!login) {
            fail(res, 'Unknown or expired login. Start the sign-in again.');
            return;
        }

        const back = (params: Record<string, string | undefined>) =>
            res.redirect(302, buildRedirect(login.clientRedirectUri, { ...params, state: login.clientState, iss: config.publicUrl.origin }));

        // RFC 9207. Unimicro advertises authorization_response_iss_parameter_supported,
        // so a response without a matching `iss` is a mix-up attack, not a quirk.
        if (q.iss !== config.issuer.origin) {
            back({ error: 'invalid_request', error_description: 'Authorization response came from an unexpected issuer.' });
            return;
        }

        if (q.error) {
            back({ error: q.error, error_description: q.error_description });
            return;
        }
        if (!q.code) {
            back({ error: 'invalid_request', error_description: 'Authorization response carried no code.' });
            return;
        }

        const tokens = await exchangeUpstream({
            grant_type: 'authorization_code',
            code: q.code,
            redirect_uri: callbackUri,
            code_verifier: login.upstreamCodeVerifier,
        });

        if (!tokens) {
            back({ error: 'server_error', error_description: 'Token exchange with Unimicro failed.' });
            return;
        }

        const code = base64url(randomBytes(32));
        codes.set(code, {
            clientId: login.clientId,
            redirectUri: login.clientRedirectUri,
            codeChallenge: login.clientCodeChallenge,
            tokens,
        });

        back({ code });
    });

    // ── Token endpoint ──────────────────────────────────────────────────────
    router.post('/oauth/token', async (req: Request, res: Response) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const grantType = str(body.grant_type);

        if (grantType === 'refresh_token') {
            const refreshToken = str(body.refresh_token);
            if (!refreshToken) {
                res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token is required.' });
                return;
            }
            const refreshed = await exchangeUpstream({ grant_type: 'refresh_token', refresh_token: refreshToken });
            if (!refreshed) {
                res.status(400).json({ error: 'invalid_grant', error_description: 'Unimicro rejected the refresh token.' });
                return;
            }
            res.json(refreshed);
            return;
        }

        if (grantType !== 'authorization_code') {
            res.status(400).json({ error: 'unsupported_grant_type', error_description: 'Supported grants: authorization_code, refresh_token.' });
            return;
        }

        const code = str(body.code);
        const issued = code ? codes.take(code) : undefined;
        if (!issued) {
            res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code is unknown, expired, or already used.' });
            return;
        }

        // The code was issued to one client for one redirect URI; both must match.
        if (str(body.client_id) !== issued.clientId || str(body.redirect_uri) !== issued.redirectUri) {
            res.status(400).json({ error: 'invalid_grant', error_description: 'client_id or redirect_uri does not match the authorization request.' });
            return;
        }

        const verifier = str(body.code_verifier);
        if (!verifier || !pkceMatches(verifier, issued.codeChallenge)) {
            res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed.' });
            return;
        }

        res.json(issued.tokens);
    });

    /**
     * POST to Unimicro's token endpoint as our upstream client.
     *
     * The secret is sent only when the registered app has one. A public
     * client (Unimicro's "Mobile/native app" type) authenticates with the
     * PKCE verifier alone, and sending an empty secret would be rejected.
     */
    async function exchangeUpstream(params: Record<string, string>): Promise<UpstreamTokens | undefined> {
        const response = await fetch(upstreamToken, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                ...params,
                client_id: config.clientId,
                ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
            }),
            signal: AbortSignal.timeout(15_000),
        }).catch(() => undefined);

        if (!response?.ok) return undefined;
        return (await response.json().catch(() => undefined)) as UpstreamTokens | undefined;
    }

    return { router, metadata: authorizationServerMetadata(config) };
}

/** RFC 8414 metadata describing this server as an authorization server. */
export function authorizationServerMetadata(config: Config): OAuthMetadata {
    const base = config.publicUrl.origin;
    return {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        scopes_supported: config.scopes,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
    } as OAuthMetadata;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Read the query string as plain strings.
 *
 * Express parses `?a[]=1&a[]=2` into an array and `?a[b]=1` into an object, so
 * a caller can hand any endpoint a non-string where a string is expected.
 * Anything that is not a single string is treated as absent.
 */
function query(req: Request): Record<string, string | undefined> {
    const result: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.query)) {
        if (typeof value === 'string') result[key] = value;
    }
    return result;
}

function fail(res: Response, message: string): void {
    res.status(400).type('text/plain').send(`Authorization request rejected.\n\n${message}\n`);
}

function buildRedirect(target: string, params: Record<string, string | undefined>): string {
    const url = new URL(target);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, value);
    }
    return url.toString();
}

/** Only forward scopes we are configured to ask for; ignore anything else a client requests. */
function requestedScope(requested: string | undefined, allowed: string[]): string {
    if (!requested) return allowed.join(' ');
    const granted = requested.split(/\s+/).filter(s => allowed.includes(s));
    return granted.length > 0 ? granted.join(' ') : allowed.join(' ');
}

function resourceMatches(requested: string, resource: URL): boolean {
    try {
        const a = new URL(requested);
        a.hash = '';
        return a.href.replace(/\/$/, '') === resource.href.replace(/\/$/, '');
    } catch {
        return false;
    }
}

function base64url(buffer: Buffer): string {
    return buffer.toString('base64url');
}

function pkceChallenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
}

function pkceMatches(verifier: string, challenge: string): boolean {
    const actual = Buffer.from(pkceChallenge(verifier));
    const expected = Buffer.from(challenge);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

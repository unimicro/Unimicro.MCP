import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fetchClientIdMetadata, isPublicAddress } from '../src/auth/clients.js';
import { startApp, type RunningApp } from './helpers.js';

/**
 * The broker is the security-sensitive half of this server, so its refusals
 * are tested as carefully as its happy path.
 */

let app: RunningApp;
const realFetch = globalThis.fetch;
const CLIENT_REDIRECT = 'http://localhost:6274/oauth/callback';

beforeAll(async () => {
    app = await startApp();
});
afterEach(() => {
    vi.unstubAllGlobals();
});
afterAll(async () => {
    await app.close();
});

async function registerClient(redirectUris: string[] = [CLIENT_REDIRECT]): Promise<string> {
    const response = await realFetch(`${app.baseUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: redirectUris, client_name: 'test' }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { client_id: string }).client_id;
}

function pkce(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeUrl(params: Record<string, string>): string {
    const url = new URL('/oauth/authorize', app.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
}

const get = (url: string) => realFetch(url, { redirect: 'manual' });

describe('dynamic client registration', () => {
    it('issues a public client id', async () => {
        expect(await registerClient()).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('refuses a registration with no redirect_uris', async () => {
        const response = await realFetch(`${app.baseUrl}/oauth/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ client_name: 'test' }),
        });
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toBe('invalid_client_metadata');
    });
});

describe('authorization request', () => {
    it('redirects to Unimicro with our own client id and a fresh PKCE challenge', async () => {
        const clientId = await registerClient();
        const { challenge } = pkce();

        const response = await get(authorizeUrl({
            client_id: clientId,
            redirect_uri: CLIENT_REDIRECT,
            response_type: 'code',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            state: 'client-state',
            resource: 'http://localhost:3000/mcp',
        }));

        expect(response.status).toBe(302);
        const location = new URL(response.headers.get('location')!);
        expect(location.origin).toBe('https://dev-login.unimicro.no');
        expect(location.pathname).toBe('/connect/authorize');
        expect(location.searchParams.get('client_id')).toBe('test-client-id');
        expect(location.searchParams.get('code_challenge_method')).toBe('S256');
        // Our upstream PKCE challenge must not be the client's.
        expect(location.searchParams.get('code_challenge')).not.toBe(challenge);
        // Nor our upstream state the client's.
        expect(location.searchParams.get('state')).not.toBe('client-state');
    });

    it('refuses an unknown client instead of redirecting anywhere', async () => {
        const response = await get(authorizeUrl({
            client_id: 'never-registered',
            redirect_uri: CLIENT_REDIRECT,
            response_type: 'code',
            code_challenge: pkce().challenge,
            code_challenge_method: 'S256',
        }));
        expect(response.status).toBe(400);
        expect(response.headers.get('location')).toBeNull();
    });

    it('refuses a redirect_uri the client did not register', async () => {
        const clientId = await registerClient();
        const response = await get(authorizeUrl({
            client_id: clientId,
            redirect_uri: 'http://evil.example/steal',
            response_type: 'code',
            code_challenge: pkce().challenge,
            code_challenge_method: 'S256',
        }));
        expect(response.status).toBe(400);
        expect(response.headers.get('location')).toBeNull();
    });

    it('requires PKCE', async () => {
        const clientId = await registerClient();
        const response = await get(authorizeUrl({
            client_id: clientId,
            redirect_uri: CLIENT_REDIRECT,
            response_type: 'code',
            state: 'client-state',
        }));

        expect(response.status).toBe(302);
        const location = new URL(response.headers.get('location')!);
        expect(location.origin + location.pathname).toBe('http://localhost:6274/oauth/callback');
        expect(location.searchParams.get('error')).toBe('invalid_request');
        expect(location.searchParams.get('state')).toBe('client-state');
    });

    it('refuses to mint a token for someone else’s resource', async () => {
        const clientId = await registerClient();
        const response = await get(authorizeUrl({
            client_id: clientId,
            redirect_uri: CLIENT_REDIRECT,
            response_type: 'code',
            code_challenge: pkce().challenge,
            code_challenge_method: 'S256',
            resource: 'https://someone-else.example/mcp',
        }));

        const location = new URL(response.headers.get('location')!);
        expect(location.searchParams.get('error')).toBe('invalid_target');
    });
});

describe('callback from the identity provider', () => {
    it('rejects a callback whose login it never issued', async () => {
        const response = await get(`${app.baseUrl}/oauth/callback?code=x&state=fabricated&iss=https://dev-login.unimicro.no`);
        expect(response.status).toBe(400);
    });

    it('rejects a callback from an unexpected issuer (RFC 9207 mix-up defence)', async () => {
        const clientId = await registerClient();
        const authorize = await get(authorizeUrl({
            client_id: clientId,
            redirect_uri: CLIENT_REDIRECT,
            response_type: 'code',
            code_challenge: pkce().challenge,
            code_challenge_method: 'S256',
        }));
        const state = new URL(authorize.headers.get('location')!).searchParams.get('state')!;

        const response = await get(`${app.baseUrl}/oauth/callback?code=x&state=${state}&iss=https://attacker.example`);
        const location = new URL(response.headers.get('location')!);
        expect(location.searchParams.get('error')).toBe('invalid_request');
        expect(location.searchParams.get('error_description')).toContain('unexpected issuer');
    });
});

describe('token endpoint', () => {
    /** Drive a full authorize → callback → token exchange with the IdP stubbed. */
    async function completeFlow(): Promise<{ code: string; verifier: string; clientId: string }> {
        const clientId = await registerClient();
        const { verifier, challenge } = pkce();

        const authorize = await get(authorizeUrl({
            client_id: clientId,
            redirect_uri: CLIENT_REDIRECT,
            response_type: 'code',
            code_challenge: challenge,
            code_challenge_method: 'S256',
        }));
        const state = new URL(authorize.headers.get('location')!).searchParams.get('state')!;

        vi.stubGlobal('fetch', async (input: any, init?: any) => {
            const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
            if (url.includes('/connect/token')) {
                return new Response(JSON.stringify({
                    access_token: 'upstream-access-token',
                    token_type: 'Bearer',
                    expires_in: 3600,
                    refresh_token: 'upstream-refresh-token',
                }), { headers: { 'content-type': 'application/json' } });
            }
            return realFetch(input, init);
        });

        const callback = await get(`${app.baseUrl}/oauth/callback?code=upstream-code&state=${state}&iss=https://dev-login.unimicro.no`);
        const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
        expect(code).toBeTruthy();

        return { code, verifier, clientId };
    }

    const redeem = (body: Record<string, string>) =>
        realFetch(`${app.baseUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(body),
        });

    it('exchanges a code for the upstream access token', async () => {
        const { code, verifier, clientId } = await completeFlow();

        const response = await redeem({
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            client_id: clientId,
            redirect_uri: CLIENT_REDIRECT,
        });

        expect(response.status).toBe(200);
        expect(((await response.json()) as { access_token: string }).access_token).toBe('upstream-access-token');
    });

    it('rejects a wrong PKCE verifier', async () => {
        const { code, clientId } = await completeFlow();

        const response = await redeem({
            grant_type: 'authorization_code',
            code,
            code_verifier: randomBytes(32).toString('base64url'),
            client_id: clientId,
            redirect_uri: CLIENT_REDIRECT,
        });

        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toBe('invalid_grant');
    });

    it('rejects a code presented by a different client', async () => {
        const { code, verifier } = await completeFlow();
        const otherClient = await registerClient();

        const response = await redeem({
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            client_id: otherClient,
            redirect_uri: CLIENT_REDIRECT,
        });

        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toBe('invalid_grant');
    });

    it('lets a code be used only once', async () => {
        const { code, verifier, clientId } = await completeFlow();
        const body = {
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            client_id: clientId,
            redirect_uri: CLIENT_REDIRECT,
        };

        expect((await redeem(body)).status).toBe(200);
        expect((await redeem(body)).status).toBe(400);
    });

    it('rejects an unsupported grant type', async () => {
        const response = await redeem({ grant_type: 'password', username: 'a', password: 'b' });
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toBe('unsupported_grant_type');
    });
});

describe('client id metadata documents', () => {
    it('refuses a non-HTTPS document URL', async () => {
        expect(await fetchClientIdMetadata('http://example.com/client.json')).toBeUndefined();
    });

    it('refuses a document hosted on a private address', async () => {
        expect(await fetchClientIdMetadata('https://127.0.0.1/client.json')).toBeUndefined();
        expect(await fetchClientIdMetadata('https://169.254.169.254/client.json')).toBeUndefined();
        expect(await fetchClientIdMetadata('https://10.0.0.1/client.json')).toBeUndefined();
    });

    it('classifies addresses the SSRF guard must refuse', () => {
        for (const address of [
            '127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255',
            '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1',
            '::1', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1',
        ]) {
            expect(isPublicAddress(address), address).toBe(false);
        }
    });

    it('classifies genuinely public addresses as reachable', () => {
        for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) {
            expect(isPublicAddress(address), address).toBe(true);
        }
    });

    it('refuses a document that claims a different client_id', async () => {
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
            client_id: 'https://elsewhere.example/client.json',
            redirect_uris: ['https://example.com/cb'],
        })));
        expect(await fetchClientIdMetadata('https://example.com/client.json')).toBeUndefined();
    });

    it('accepts a well-formed document', async () => {
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
            client_id: 'https://example.com/client.json',
            redirect_uris: ['https://example.com/cb'],
        })));
        expect(await fetchClientIdMetadata('https://example.com/client.json')).toEqual({
            clientId: 'https://example.com/client.json',
            redirectUris: ['https://example.com/cb'],
        });
    });
});

describe('hostile input', () => {
    it('treats a repeated query parameter as absent rather than crashing', async () => {
        const response = await get(
            `${app.baseUrl}/oauth/authorize?client_id[]=a&client_id[]=b&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT)}&response_type=code`,
        );
        expect(response.status).toBe(400);
    });

    it('survives a nested-object query parameter', async () => {
        const response = await get(`${app.baseUrl}/oauth/authorize?client_id[evil]=1&redirect_uri[x]=2`);
        expect(response.status).toBe(400);
    });
});

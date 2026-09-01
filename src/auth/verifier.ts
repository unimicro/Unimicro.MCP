import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';

/**
 * Validates the bearer token on every MCP request.
 *
 * The token is Unimicro's, verified locally against Unimicro's JWKS — no
 * introspection round-trip on the hot path. `jose` caches and rotates the key
 * set for us.
 *
 * ## On audience
 *
 * MCP 2026-07-28 says a resource server MUST reject tokens not issued for
 * itself. Unimicro issues tokens audienced to its API resource (`AppFramework`)
 * and does not implement RFC 8707 resource indicators, so no token will ever
 * carry this server's URL in `aud`. We therefore accept the upstream audience
 * and rely on the broker never handing a token to a client that did not
 * complete a flow naming this resource.
 *
 * That is a deliberate, documented deviation, and it is safe only because this
 * server is a facade over the very API the token was minted for — it cannot
 * escalate a token beyond what its holder could already do directly. If you
 * fork this to front a *different* API, mint your own tokens instead.
 * docs/AUTH.md spells out what that entails.
 */
export function createTokenVerifier(config: Config): OAuthTokenVerifier {
    const jwks = createRemoteJWKSet(new URL('/.well-known/openid-configuration/jwks', config.issuer));

    return {
        async verifyAccessToken(token: string): Promise<AuthInfo> {
            let payload: JWTPayload;
            try {
                ({ payload } = await jwtVerify(token, jwks, {
                    issuer: config.issuer.origin,
                    clockTolerance: 60,
                }));
            } catch (cause) {
                throw new OAuthError(
                    OAuthErrorCode.InvalidToken,
                    `Access token failed validation against ${config.issuer.origin}: ${(cause as Error).message}`,
                );
            }

            // The bearer-auth helpers reject tokens with no expiry, and so should we.
            if (typeof payload.exp !== 'number') {
                throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token has no exp claim.');
            }

            const subject = typeof payload.sub === 'string' ? payload.sub : undefined;
            if (!subject) {
                throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token has no sub claim.');
            }

            return {
                token,
                clientId: typeof payload.client_id === 'string' ? payload.client_id : config.clientId,
                scopes: parseScopes(payload.scope),
                expiresAt: payload.exp,
                extra: {
                    subject,
                    name: typeof payload.name === 'string' ? payload.name : undefined,
                },
            };
        },
    };
}

/** `scope` is a space-delimited string in OAuth, but some issuers send an array. */
function parseScopes(scope: unknown): string[] {
    if (typeof scope === 'string') return scope.split(/\s+/).filter(Boolean);
    if (Array.isArray(scope)) return scope.filter((s): s is string => typeof s === 'string');
    return [];
}

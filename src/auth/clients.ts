import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { TtlStore } from './store.js';

/**
 * Working out which redirect URIs a calling MCP client is allowed to use.
 *
 * MCP clients arrive without a pre-arranged relationship, so the spec gives
 * them two ways to identify themselves. We support both:
 *
 *   - **Client ID Metadata Documents** — the client_id *is* an HTTPS URL that
 *     serves its own metadata. This is the path MCP 2026-07-28 prefers: no
 *     registration call, no server-side storage, nothing to expire.
 *   - **Dynamic Client Registration** (RFC 7591) — the client POSTs to
 *     /oauth/register and gets an opaque id back. Formally deprecated in
 *     2026-07-28, kept here because clients still in the field use it.
 */

export interface ClientRegistration {
    clientId: string;
    redirectUris: string[];
}

/** DCR registrations live for a week; a restart clears them and clients re-register. */
const DCR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class ClientRegistry {
    readonly #registered = new TtlStore<ClientRegistration>(DCR_TTL_MS);

    /** RFC 7591 dynamic registration. Public clients only — we never issue a client secret. */
    register(redirectUris: string[]): ClientRegistration {
        const registration: ClientRegistration = { clientId: randomUUID(), redirectUris };
        this.#registered.set(registration.clientId, registration);
        return registration;
    }

    /**
     * Resolve a client_id to its allowed redirect URIs, or `undefined` when the
     * client is unknown. A URL-shaped client_id is fetched as a CIMD; anything
     * else is looked up among dynamic registrations.
     */
    async resolve(clientId: string): Promise<ClientRegistration | undefined> {
        if (clientId.startsWith('https://')) return fetchClientIdMetadata(clientId);
        return this.#registered.get(clientId);
    }
}

/**
 * Fetch and validate a Client ID Metadata Document.
 *
 * The client_id is a URL we are about to fetch on an unauthenticated caller's
 * say-so, which is a server-side request forgery primitive if we are careless.
 * Hence: HTTPS only, no redirects followed, public IPs only, hard timeout,
 * bounded body, and the document must claim the same client_id we asked for.
 */
export async function fetchClientIdMetadata(clientId: string): Promise<ClientRegistration | undefined> {
    let url: URL;
    try {
        url = new URL(clientId);
    } catch {
        return undefined;
    }
    if (url.protocol !== 'https:') return undefined;
    if (url.hash) return undefined;
    if (!(await isPubliclyRoutable(url.hostname))) return undefined;

    const response = await fetch(url, {
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);

    if (!response?.ok) return undefined;

    // Cap the body so a hostile URL cannot stream us out of memory.
    const body = await response.text().catch(() => '');
    if (body.length > 64 * 1024) return undefined;

    let document: unknown;
    try {
        document = JSON.parse(body);
    } catch {
        return undefined;
    }
    if (typeof document !== 'object' || document === null) return undefined;

    const { client_id, redirect_uris } = document as Record<string, unknown>;

    // The document must self-identify as this exact client_id, otherwise any
    // page on the internet could vouch for redirect URIs it does not own.
    if (client_id !== clientId) return undefined;
    if (!Array.isArray(redirect_uris)) return undefined;

    const redirectUris = redirect_uris.filter((u): u is string => typeof u === 'string' && u.length > 0);
    if (redirectUris.length === 0) return undefined;

    return { clientId, redirectUris };
}

/**
 * Reject hostnames that resolve to loopback, link-local, or private space.
 * Without this, `client_id=https://internal.corp/…` turns the broker into a
 * probe for the network it is deployed in.
 */
async function isPubliclyRoutable(hostname: string): Promise<boolean> {
    const addresses = isIP(hostname)
        ? [{ address: hostname }]
        : await lookup(hostname, { all: true }).catch(() => []);

    if (addresses.length === 0) return false;
    return addresses.every(({ address }) => isPublicAddress(address));
}

/**
 * True when an IP literal is on the public internet. Exported so the
 * classification can be unit-tested without touching DNS.
 */
export function isPublicAddress(address: string): boolean {
    if (isIP(address) === 6) {
        const v6 = address.toLowerCase();
        if (v6 === '::1' || v6 === '::') return false;
        if (v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd')) return false;
        // IPv4-mapped (::ffff:10.0.0.1) — judge the embedded IPv4 address.
        const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped?.[1]) return isPublicAddress(mapped[1]);
        return true;
    }

    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n))) return false;
    const [a = 0, b = 0] = parts;

    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;            // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;  // carrier-grade NAT
    if (a >= 224) return false;                          // multicast and reserved
    return true;
}

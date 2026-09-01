/**
 * Print a bearer token for the running server.
 *
 *     npm run token
 *
 * Every curl in docs/CONNECTING.md needs an `Authorization: Bearer …` header,
 * and getting one by hand means writing a PKCE client. This is that client: it
 * registers with the broker, opens a callback listener, prints a URL for you to
 * sign in with, and prints the token it gets back.
 *
 * It talks only to this server, exactly as any MCP client would — so if it
 * works, the broker works.
 */
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const base = config.publicUrl.origin;

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('base64url');

// Port 0 asks the OS for a free port, so this never collides with anything.
const { port, waitForCode, close } = await listenForCallback();
const redirectUri = `http://localhost:${port}/callback`;

const clientId = await register(redirectUri);

const authorizeUrl = new URL('/oauth/authorize', base);
authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource: config.resourceUrl.href,
}).toString();

console.log('\nOpen this and sign in:\n');
console.log(`  ${authorizeUrl.href}\n`);
console.log('Waiting for the callback…');

const code = await waitForCode(state);
close();

const token = await exchange(code, clientId, redirectUri);

console.log('\nAccess token (valid ~1 hour):\n');
console.log(token.access_token);
console.log('\nUse it like this:\n');
console.log(`  export TOKEN='${token.access_token.slice(0, 12)}…'   # the full value is above`);
console.log(`  curl -sN -X POST ${config.resourceUrl.href} -H "Authorization: Bearer $TOKEN" …\n`);
if (!token.refresh_token) {
    console.log('No refresh token: add `offline_access` to UNIMICRO_SCOPES and to your');
    console.log('client in the portal if you want one. See docs/AUTH.md.\n');
}

// ── steps ───────────────────────────────────────────────────────────────────

async function register(redirect: string): Promise<string> {
    const response = await fetch(`${base}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirect], client_name: 'npm run token' }),
    }).catch(() => undefined);

    if (!response) {
        fail(`Could not reach ${base}. Is the server running? Start it with: npm run dev`);
    }
    if (!response.ok) fail(`Registration failed: ${response.status} ${await response.text()}`);

    return ((await response.json()) as { client_id: string }).client_id;
}

async function exchange(code: string, clientId: string, redirect: string) {
    const response = await fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            client_id: clientId,
            redirect_uri: redirect,
        }),
    });

    const body = await response.text();
    if (!response.ok) fail(`Token exchange failed: ${response.status} ${body}`);

    return JSON.parse(body) as { access_token: string; refresh_token?: string };
}

function listenForCallback() {
    let resolveCode: (code: string) => void;
    let rejectCode: (error: Error) => void;
    const received = new Promise<string>((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
    });

    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');

        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(error ? `Sign-in failed: ${error}\nBack to the terminal.` : 'Signed in. Back to the terminal.');

        if (error) rejectCode(new Error(`${error}: ${url.searchParams.get('error_description') ?? ''}`));
        else if (code) resolveCode(`${code}|${url.searchParams.get('state') ?? ''}`);
    });

    return new Promise<{ port: number; waitForCode: (state: string) => Promise<string>; close: () => void }>(resolve => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (address === null || typeof address === 'string') fail('Could not open a callback port.');
            resolve({
                port: address.port,
                close: () => server.close(),
                waitForCode: async expected => {
                    const [code, returned] = (await received).split('|');
                    // The broker echoes state back; a mismatch means this is not our flow.
                    if (returned !== expected) fail('State mismatch on the callback — aborting.');
                    return code!;
                },
            });
        });
    });
}

function fail(message: string): never {
    console.error(`\n${message}\n`);
    process.exit(1);
}

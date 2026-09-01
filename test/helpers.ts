import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';

export const TEST_ENV = {
    PUBLIC_URL: 'http://localhost:3000',
    UNIMICRO_CLIENT_ID: 'test-client-id',
    UNIMICRO_CLIENT_SECRET: 'test-client-secret',
} satisfies NodeJS.ProcessEnv;

export function testConfig(overrides: NodeJS.ProcessEnv = {}): Config {
    return loadConfig({ ...TEST_ENV, ...overrides });
}

/** A verifier that accepts exactly one token, so tests need no identity provider. */
export const stubVerifier: OAuthTokenVerifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
        if (token !== 'valid-token') throw new OAuthError(OAuthErrorCode.InvalidToken, 'Unknown test token.');
        return {
            token,
            clientId: 'test-client-id',
            scopes: ['AppFramework'],
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            extra: { subject: 'user-1' },
        };
    },
};

export interface RunningApp {
    baseUrl: string;
    close(): Promise<void>;
}

export async function startApp(config: Config = testConfig()): Promise<RunningApp> {
    const app = createApp(config, { verifier: stubVerifier });
    const server: Server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    return {
        baseUrl: `http://localhost:${port}`,
        close: () => new Promise<void>(resolve => server.close(() => resolve())),
    };
}

/**
 * Send one MCP request the way a 2026-07-28 client does: routing headers on
 * the outside, the required `_meta` envelope on the inside.
 */
export async function mcpCall(
    baseUrl: string,
    method: string,
    params: Record<string, unknown> = {},
    { token = 'valid-token', name, headers: extraHeaders }: { token?: string; name?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': method,
    };
    if (name) headers['Mcp-Name'] = name;
    if (token) headers['authorization'] = `Bearer ${token}`;
    Object.assign(headers, extraHeaders);

    const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method,
            params: {
                ...params,
                _meta: {
                    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                    'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
                    'io.modelcontextprotocol/clientCapabilities': { elicitation: {} },
                },
            },
        }),
    });

    const text = await response.text();
    // Responses may arrive as a single JSON body or as one SSE `data:` frame.
    const payload = text.startsWith('data:')
        ? text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('')
        : text;

    return { status: response.status, body: payload ? JSON.parse(payload) : undefined };
}

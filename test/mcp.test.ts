import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mcpCall, startApp, type RunningApp } from './helpers.js';

/**
 * End-to-end over real HTTP, with only the identity provider and the Unimicro
 * API stubbed. These tests are the executable version of docs/CONNECTING.md.
 */

let app: RunningApp;
const realFetch = globalThis.fetch;

/** Intercept outbound calls to the Unimicro API; let everything else through. */
function stubUnimicro(routes: Record<string, unknown>): void {
    vi.stubGlobal('fetch', async (input: any, init?: any) => {
        const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
        for (const [fragment, body] of Object.entries(routes)) {
            if (url.includes(fragment)) {
                return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
            }
        }
        return realFetch(input, init);
    });
}

beforeAll(async () => {
    app = await startApp();
});
afterEach(() => {
    vi.unstubAllGlobals();
});
afterAll(async () => {
    await app.close();
});

describe('authentication', () => {
    it('challenges an unauthenticated request with a discoverable resource', async () => {
        const response = await realFetch(`${app.baseUrl}/mcp`, { method: 'POST', body: '{}' });
        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
    });

    it('rejects a token the verifier does not accept', async () => {
        const { status } = await mcpCall(app.baseUrl, 'tools/list', {}, { token: 'nope' });
        expect(status).toBe(401);
    });
});

describe('tools/list', () => {
    it('advertises the tool with an input schema, output schema and annotations', async () => {
        const { body } = await mcpCall(app.baseUrl, 'tools/list');
        const tools: any[] = body.result.tools;

        expect(tools.map(t => t.name)).toEqual(['check_api_access']);

        const [tool] = tools;
        expect(tool.title).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeTruthy();
        expect(tool.outputSchema).toBeTruthy();
        expect(tool.annotations.readOnlyHint).toBe(true);
    });
});

describe('check_api_access', () => {
    const call = (headers?: Record<string, string>) =>
        mcpCall(app.baseUrl, 'tools/call', { name: 'check_api_access', arguments: {} }, { name: 'check_api_access', headers });

    it('reports the API it reached and the companies it found', async () => {
        stubUnimicro({
            '/api/init/companies': [{ Key: 'c-1', Name: 'Test AS', OrganizationNumber: '123456789' }],
        });

        const { body } = await call();

        expect(body.result.structuredContent).toEqual({
            ok: true,
            apiBaseUrl: 'https://test.unimicro.no',
            companyCount: 1,
            companies: [{ companyKey: 'c-1', name: 'Test AS', organizationNumber: '123456789' }],
            defaultCompanyKey: 'c-1',
            notes: [],
        });
        expect(body.result.content[0].text).toContain('Test AS');
    });

    it('reports no default company, with a reason, when the choice is ambiguous', async () => {
        stubUnimicro({
            '/api/init/companies': [{ Key: 'c-1', Name: 'One AS' }, { Key: 'c-2', Name: 'Two AS' }],
        });

        const { body } = await call();
        const result = body.result.structuredContent;

        expect(result.companyCount).toBe(2);
        expect(result.defaultCompanyKey).toBeNull();
        expect(result.notes.join(' ')).toContain('several companies');
        expect(result.notes.join(' ')).toContain('c-2');
    });

    it('honours a CompanyKey header from the host', async () => {
        stubUnimicro({
            '/api/init/companies': [{ Key: 'c-1', Name: 'One AS' }, { Key: 'c-2', Name: 'Two AS' }],
        });

        const { body } = await call({ CompanyKey: 'c-2' });
        const result = body.result.structuredContent;

        expect(result.defaultCompanyKey).toBe('c-2');
        expect(result.notes.join(' ')).toContain('CompanyKey header');
    });

    it('reports an empty company list rather than failing', async () => {
        stubUnimicro({ '/api/init/companies': [] });

        const { body } = await call();
        const result = body.result.structuredContent;

        expect(result.companyCount).toBe(0);
        expect(result.defaultCompanyKey).toBeNull();
        expect(result.notes.join(' ')).toContain('no Unimicro companies');
    });

    it('surfaces an API failure as a tool error the model can act on', async () => {
        vi.stubGlobal('fetch', async (input: any, init?: any) => {
            const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
            if (url.includes('/api/init/companies')) return new Response('nope', { status: 403 });
            return realFetch(input, init);
        });

        const { body } = await call();

        expect(body.result.isError).toBe(true);
        expect(body.result.content[0].text).toContain('403');
    });
});

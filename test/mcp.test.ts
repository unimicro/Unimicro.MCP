import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

afterAll(async () => {
    vi.unstubAllGlobals();
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
    it('advertises every tool with an input and output schema', async () => {
        const { body } = await mcpCall(app.baseUrl, 'tools/list');
        const tools: any[] = body.result.tools;

        expect(tools.map(t => t.name).sort()).toEqual(['create_customer', 'find_customers', 'list_companies']);
        for (const tool of tools) {
            expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
            expect(tool.inputSchema, `${tool.name} needs an inputSchema`).toBeTruthy();
            expect(tool.outputSchema, `${tool.name} needs an outputSchema`).toBeTruthy();
        }
    });

    it('marks read-only tools as read-only', async () => {
        const { body } = await mcpCall(app.baseUrl, 'tools/list');
        const byName = Object.fromEntries(body.result.tools.map((t: any) => [t.name, t]));

        expect(byName.find_customers.annotations.readOnlyHint).toBe(true);
        expect(byName.create_customer.annotations.readOnlyHint).toBe(false);
    });
});

describe('tools/call', () => {
    it('returns structured content that matches the declared output schema', async () => {
        stubUnimicro({
            '/api/init/companies': [{ Key: 'c-1', Name: 'Test AS', OrganizationNumber: '123456789' }],
        });

        const { body } = await mcpCall(app.baseUrl, 'tools/call', { name: 'list_companies', arguments: {} }, { name: 'list_companies' });

        expect(body.result.structuredContent).toEqual({
            companies: [{ companyKey: 'c-1', name: 'Test AS', organizationNumber: '123456789' }],
        });
        expect(body.result.content[0].text).toContain('Test AS');
    });

    it('resolves the company automatically when the user has exactly one', async () => {
        stubUnimicro({
            '/api/init/companies': [{ Key: 'c-1', Name: 'Test AS' }],
            '/api/biz/customers': [{ ID: 7, CustomerNumber: 1001, OrgNumber: '999888777', Info: { Name: 'Acme' } }],
        });

        const { body } = await mcpCall(app.baseUrl, 'tools/call', {
            name: 'find_customers',
            arguments: { name: 'acme' },
        }, { name: 'find_customers' });

        expect(body.result.structuredContent).toEqual({
            count: 1,
            customers: [{ id: 7, name: 'Acme', customerNumber: 1001, organizationNumber: '999888777' }],
        });
    });

    it('asks which company to use when the choice is ambiguous', async () => {
        stubUnimicro({
            '/api/init/companies': [{ Key: 'c-1', Name: 'One AS' }, { Key: 'c-2', Name: 'Two AS' }],
        });

        const { body } = await mcpCall(app.baseUrl, 'tools/call', {
            name: 'find_customers',
            arguments: {},
        }, { name: 'find_customers' });

        expect(body.result.isError).toBe(true);
        expect(body.result.content[0].text).toContain('companyKey');
        expect(body.result.content[0].text).toContain('c-2');
    });

    it('rejects arguments that do not match the input schema', async () => {
        const { body } = await mcpCall(app.baseUrl, 'tools/call', {
            name: 'find_customers',
            arguments: { organizationNumber: 'not-nine-digits' },
        }, { name: 'find_customers' });

        expect(body.error ?? body.result.isError).toBeTruthy();
    });
});

describe('writes ask before they act', () => {
    it('returns an input_required result instead of writing on the first call', async () => {
        stubUnimicro({ '/api/init/companies': [{ Key: 'c-1', Name: 'Test AS' }] });

        const { body } = await mcpCall(app.baseUrl, 'tools/call', {
            name: 'create_customer',
            arguments: { name: 'New Customer AS' },
        }, { name: 'create_customer' });

        expect(body.result.resultType).toBe('input_required');
        expect(body.result.inputRequests.confirm.method).toBe('elicitation/create');
        expect(body.result.inputRequests.confirm.params.message).toContain('New Customer AS');
    });

    it('writes once the user has confirmed', async () => {
        stubUnimicro({
            '/api/init/companies': [{ Key: 'c-1', Name: 'Test AS' }],
            '/api/biz/customers': { ID: 42, CustomerNumber: 1002, Info: { Name: 'New Customer AS' } },
        });

        const { body } = await mcpCall(app.baseUrl, 'tools/call', {
            name: 'create_customer',
            arguments: { name: 'New Customer AS' },
            inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
        }, { name: 'create_customer' });

        expect(body.result.structuredContent).toEqual({
            created: true,
            customer: { id: 42, name: 'New Customer AS', customerNumber: 1002 },
        });
    });

    it('writes nothing when the user declines', async () => {
        stubUnimicro({ '/api/init/companies': [{ Key: 'c-1', Name: 'Test AS' }] });

        const { body } = await mcpCall(app.baseUrl, 'tools/call', {
            name: 'create_customer',
            arguments: { name: 'Unwanted AS' },
            inputResponses: { confirm: { action: 'accept', content: { confirm: false } } },
        }, { name: 'create_customer' });

        expect(body.result.structuredContent).toEqual({ created: false });
        expect(body.result.content[0].text).toContain('Cancelled');
    });
});

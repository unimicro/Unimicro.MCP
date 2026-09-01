import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { TEST_ENV } from './helpers.js';

describe('configuration', () => {
    it('names the missing variables when credentials are absent', () => {
        expect(() => loadConfig({})).toThrow(/UNIMICRO_CLIENT_ID/);
        expect(() => loadConfig({})).toThrow(/UNIMICRO_CLIENT_SECRET/);
    });

    it('defaults to the Unimicro test environment', () => {
        const config = loadConfig(TEST_ENV);
        expect(config.issuer.origin).toBe('https://test-login.unimicro.no');
        expect(config.apiBaseUrl.origin).toBe('https://test.unimicro.no');
        expect(config.resourceUrl.href).toBe('http://localhost:5008/mcp');
        expect(config.isLocalhost).toBe(true);
    });

    it('refuses a plain-HTTP public URL outside localhost', () => {
        expect(() => loadConfig({ ...TEST_ENV, PUBLIC_URL: 'http://mcp.example.com' }))
            .toThrow(/must use https/);
    });

    it('accepts an HTTPS public URL and stops treating it as local', () => {
        const config = loadConfig({ ...TEST_ENV, PUBLIC_URL: 'https://mcp.example.com' });
        expect(config.isLocalhost).toBe(false);
        expect(config.resourceUrl.href).toBe('https://mcp.example.com/mcp');
    });

    it('splits scopes and extra origins', () => {
        const config = loadConfig({
            ...TEST_ENV,
            UNIMICRO_SCOPES: 'openid  AppFramework',
            ALLOWED_ORIGINS: 'https://a.example, https://b.example',
        });
        expect(config.scopes).toEqual(['openid', 'AppFramework']);
        expect(config.allowedOrigins).toEqual(['https://a.example', 'https://b.example']);
    });
});

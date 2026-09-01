import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { TEST_ENV } from './helpers.js';

describe('configuration', () => {
    it('names the missing variable when the client id is absent', () => {
        expect(() => loadConfig({})).toThrow(/UNIMICRO_CLIENT_ID/);
    });

    it('accepts a public client, which has no secret', () => {
        const { UNIMICRO_CLIENT_SECRET, ...publicClient } = TEST_ENV;
        expect(loadConfig(publicClient).clientSecret).toBeUndefined();
    });

    it('keeps the secret for a confidential client', () => {
        expect(loadConfig(TEST_ENV).clientSecret).toBe('test-client-secret');
    });

    it('defaults to the environment the sign-up in the README provisions', () => {
        const config = loadConfig(TEST_ENV);
        expect(config.issuer.origin).toBe('https://dev-login.unimicro.no');
        expect(config.apiBaseUrl.origin).toBe('https://dev.unimicro.no');
        expect(config.resourceUrl.href).toBe('http://localhost:3000/mcp');
        expect(config.isLocalhost).toBe(true);
    });

    it('follows PORT when PUBLIC_URL is not set', () => {
        // Otherwise the server listens on one port and advertises another, and
        // every OAuth document points somewhere nothing is running.
        const { PUBLIC_URL, ...env } = TEST_ENV;
        const config = loadConfig({ ...env, PORT: '3010' });
        expect(config.port).toBe(3010);
        expect(config.publicUrl.origin).toBe('http://localhost:3010');
        expect(config.resourceUrl.href).toBe('http://localhost:3010/mcp');
    });

    it('lets an explicit PUBLIC_URL win over PORT', () => {
        const config = loadConfig({ ...TEST_ENV, PORT: '3010', PUBLIC_URL: 'https://mcp.example.com' });
        expect(config.port).toBe(3010);
        expect(config.publicUrl.origin).toBe('https://mcp.example.com');
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

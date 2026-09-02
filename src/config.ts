import { z } from 'zod';

/**
 * Unimicro's environments. Each is a matched set: register in the portal on the
 * same row as the issuer you point at, or sign-in fails with an error that
 * never mentions environments.
 *
 * `test` is the default because it is the one external developers reach:
 * developer.unimicro.no signs in against test-login and takes a GitHub sign-up.
 * `dev` is Unimicro's own lane and needs an account there.
 *
 * Pick one with `UNIMICRO_ENV`; the individual URLs below override it when you
 * need something these rows do not cover.
 */
export const ENVIRONMENTS = {
    dev: {
        issuer: 'https://dev-login.unimicro.no',
        api: 'https://dev.unimicro.no',
        portal: 'https://dev-developer.unimicro.no',
    },
    test: {
        issuer: 'https://test-login.unimicro.no',
        api: 'https://test.unimicro.no',
        portal: 'https://developer.unimicro.no',
    },
} as const;

export type EnvironmentName = keyof typeof ENVIRONMENTS;

/**
 * Every knob this server has, read from the environment once at startup.
 *
 * There is nothing to rename when you fork this repo — copy `.env.example`
 * to `.env`, fill in the two Unimicro credentials, and run.
 */
const schema = z.object({
    PORT: z.coerce.number().int().positive().default(3000),

    /**
     * The public origin this server is reachable on. It is the OAuth issuer
     * identifier and the base of every URL advertised in discovery documents,
     * so it must match what clients actually dial — including the port.
     *
     * Left unset it follows `PORT`, so changing the port alone cannot leave the
     * server advertising an address it is not listening on. Set it explicitly
     * only when the public address differs from the bind address — behind a
     * proxy, or in a container.
     */
    PUBLIC_URL: z.url().optional(),

    /**
     * Which Unimicro environment to talk to. This is the one switch: it sets the
     * identity provider and the API together, so they cannot drift apart.
     */
    UNIMICRO_ENV: z.enum(['dev', 'test']).default('test'),

    /** Overrides `UNIMICRO_ENV`'s identity provider. Rarely needed. */
    UNIMICRO_ISSUER: z.url().optional(),

    /** Overrides `UNIMICRO_ENV`'s API base URL. Rarely needed. */
    UNIMICRO_API_BASE_URL: z.url().optional(),

    /**
     * The client on the application you registered in the developer portal.
     * Unimicro offers no dynamic registration, so this id is fixed at
     * registration time.
     *
     * Checked after parsing rather than here, so the error can name the portal
     * for the environment actually selected.
     */
    UNIMICRO_CLIENT_ID: z.string().optional(),

    /**
     * The secret for that app, when it has one.
     *
     * A "Regular web app" client is confidential and needs it. A
     * "Mobile/native app" client is public: it authenticates with PKCE alone,
     * and this is left empty. Both work — see docs/AUTH.md.
     */
    UNIMICRO_CLIENT_SECRET: z.string().optional(),

    /**
     * Scopes requested upstream. These must all be listed on your client in the
     * portal — asking for one it does not have fails the sign-in with
     * `invalid_scope`. `AppFramework` is the one that grants API access.
     */
    UNIMICRO_SCOPES: z.string().default('openid profile AppFramework'),

    /** Extra browser origins allowed to call /mcp. localhost is always allowed. */
    ALLOWED_ORIGINS: z.string().default(''),

    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = Readonly<{
    port: number;
    publicUrl: URL;
    /** Canonical RFC 8707 resource identifier for this MCP server. */
    resourceUrl: URL;
    /** Which row of ENVIRONMENTS is in play, or 'custom' when the URLs match none. */
    environment: EnvironmentName | 'custom';
    /** Where to register an application for this environment, when it is a known one. */
    portalUrl: URL | undefined;
    issuer: URL;
    apiBaseUrl: URL;
    clientId: string;
    clientSecret: string | undefined;
    scopes: string[];
    allowedOrigins: string[];
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    /** True when we are on plain-HTTP localhost, which relaxes a few HTTPS-only checks. */
    isLocalhost: boolean;
}>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const parsed = schema.safeParse(env);
    if (!parsed.success) {
        const issues = parsed.error.issues.map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
        throw new Error(`Invalid configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
    }
    const e = parsed.data;
    // Default the public origin from the port actually bound, so the two cannot
    // drift apart. A wrong PUBLIC_URL is invisible until sign-in fails.
    const publicUrl = new URL(e.PUBLIC_URL ?? `http://localhost:${e.PORT}`);
    const hostname = publicUrl.hostname;
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

    if (!isLocalhost && publicUrl.protocol !== 'https:') {
        throw new Error(`PUBLIC_URL must use https outside localhost (got ${publicUrl.origin}). OAuth issuers are HTTPS-only.`);
    }

    const preset = ENVIRONMENTS[e.UNIMICRO_ENV];
    const issuer = new URL(e.UNIMICRO_ISSUER ?? preset.issuer);
    const apiBaseUrl = new URL(e.UNIMICRO_API_BASE_URL ?? preset.api);

    // Report the row the URLs actually landed on, not the one that was asked
    // for: overriding one of the pair is how a mixed set happens, and naming it
    // 'custom' in the startup banner is what makes that visible.
    const matched = (Object.keys(ENVIRONMENTS) as EnvironmentName[])
        .find(name => ENVIRONMENTS[name].issuer === issuer.origin && ENVIRONMENTS[name].api === apiBaseUrl.origin);

    if (!e.UNIMICRO_CLIENT_ID) {
        const where = matched
            ? `Register an application at ${ENVIRONMENTS[matched].portal} — the portal for the ${matched} environment.`
            : `The issuer and API do not match a known environment, so register wherever ${issuer.origin} is administered.`;
        throw new Error(`Invalid configuration:\n  UNIMICRO_CLIENT_ID: required\n\n${where}\nSee the README.`);
    }

    return Object.freeze({
        port: e.PORT,
        publicUrl,
        resourceUrl: new URL('/mcp', publicUrl),
        environment: matched ?? 'custom',
        portalUrl: matched ? new URL(ENVIRONMENTS[matched].portal) : undefined,
        issuer,
        apiBaseUrl,
        clientId: e.UNIMICRO_CLIENT_ID,
        clientSecret: e.UNIMICRO_CLIENT_SECRET || undefined,
        scopes: e.UNIMICRO_SCOPES.split(/\s+/).filter(Boolean),
        allowedOrigins: e.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean),
        logLevel: e.LOG_LEVEL,
        isLocalhost,
    });
}

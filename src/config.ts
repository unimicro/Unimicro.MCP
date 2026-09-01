import { z } from 'zod';

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
     */
    PUBLIC_URL: z.url().default('http://localhost:3000'),

    /**
     * Unimicro's identity provider. The default matches the environment you get
     * from the self-service sign-up in the README. Never point a fork at
     * production without reading docs/AUTH.md.
     */
    UNIMICRO_ISSUER: z.url().default('https://dev-login.unimicro.no'),

    /** The API base URL that serves `/api/...`, paired with the issuer above. */
    UNIMICRO_API_BASE_URL: z.url().default('https://dev.unimicro.no'),

    /**
     * The app you registered at developer.unimicro.no. Unimicro offers no
     * dynamic registration, so this id is fixed at registration time.
     */
    UNIMICRO_CLIENT_ID: z.string().min(1, 'UNIMICRO_CLIENT_ID is required — register an app at https://developer.unimicro.no/portal/applications'),

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
    const publicUrl = new URL(e.PUBLIC_URL);
    const hostname = publicUrl.hostname;
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

    if (!isLocalhost && publicUrl.protocol !== 'https:') {
        throw new Error(`PUBLIC_URL must use https outside localhost (got ${publicUrl.origin}). OAuth issuers are HTTPS-only.`);
    }

    return Object.freeze({
        port: e.PORT,
        publicUrl,
        resourceUrl: new URL('/mcp', publicUrl),
        issuer: new URL(e.UNIMICRO_ISSUER),
        apiBaseUrl: new URL(e.UNIMICRO_API_BASE_URL),
        clientId: e.UNIMICRO_CLIENT_ID,
        clientSecret: e.UNIMICRO_CLIENT_SECRET || undefined,
        scopes: e.UNIMICRO_SCOPES.split(/\s+/).filter(Boolean),
        allowedOrigins: e.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean),
        logLevel: e.LOG_LEVEL,
        isLocalhost,
    });
}

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { createMcpHandler, McpServer, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import {
    createMcpExpressApp,
    getOAuthProtectedResourceMetadataUrl,
    mcpAuthMetadataRouter,
    requireBearerAuth,
} from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Config } from './config.js';
import { createAuthBroker } from './auth/broker.js';
import { createTokenVerifier } from './auth/verifier.js';
import { UnimicroApi } from './unimicro/api.js';
import { createToolContext, registerTools } from './tools/index.js';

export const SERVER_NAME = 'unimicro';
export const SERVER_VERSION = '1.0.0';

/**
 * Wires the whole server together. Four things live at the root:
 *
 *   /oauth/*         the authorization broker (src/auth/broker.ts)
 *   /.well-known/*   OAuth discovery documents, served by the SDK
 *   /mcp             the MCP endpoint itself, behind bearer authentication
 *   /health          a liveness probe
 *
 * Exported separately from `index.ts` so tests can drive the app without
 * binding a port.
 */
export interface AppOverrides {
    /** Swap in a stub token verifier so tests need no live identity provider. */
    verifier?: OAuthTokenVerifier;
}

export function createApp(config: Config, overrides: AppOverrides = {}): Express {
    const verifier = overrides.verifier ?? createTokenVerifier(config);
    const broker = createAuthBroker(config);

    const allowedHosts = [config.publicUrl.hostname, 'localhost', '127.0.0.1', '[::1]'];
    const allowedOrigins = [
        ...allowedHosts,
        ...config.allowedOrigins.map(origin => safeHostname(origin)).filter((h): h is string => h !== undefined),
    ];

    // Installs express.json(), Host-header (DNS rebinding) and Origin checks.
    const app = createMcpExpressApp({
        host: config.isLocalhost ? 'localhost' : '0.0.0.0',
        allowedHosts,
        allowedOrigins,
    });

    // The OAuth token endpoint is form-encoded, not JSON.
    app.use(express.urlencoded({ extended: false }));

    app.use(cors(allowedOrigins));
    app.use(broker.router);

    // RFC 9728 protected-resource metadata + RFC 8414 authorization-server
    // metadata. This is how a client with no configuration finds its way from
    // a 401 to a sign-in page.
    app.use(mcpAuthMetadataRouter({
        oauthMetadata: broker.metadata,
        resourceServerUrl: config.resourceUrl,
        scopesSupported: config.scopes,
        resourceName: 'Unimicro',
        // Only reachable on plain-HTTP localhost, where there is no issuer to protect.
        dangerouslyAllowInsecureIssuerUrl: config.isLocalhost,
    }));

    // One fresh McpServer per request: that is what "stateless" means in
    // 2026-07-28, and it is why this server scales behind a plain load
    // balancer with no session affinity.
    const handler = createMcpHandler(ctx => {
        const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

        const token = ctx.authInfo?.token;
        if (token) {
            const api = new UnimicroApi(token, config.apiBaseUrl);
            const companyKey = ctx.requestInfo?.headers.get('companykey') ?? undefined;
            registerTools(server, createToolContext(api, companyKey));
        }

        return server;
    });

    // `express.json()` has already drained the request stream, so hand the
    // parsed body to the adapter rather than letting it read an empty socket.
    const mcpHandler = toNodeHandler(handler);
    app.all('/mcp', requireBearerAuth({
        verifier,
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.resourceUrl),
    }), (req, res) => mcpHandler(req, res, req.body));

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', server: SERVER_NAME, version: SERVER_VERSION });
    });

    app.get('/', (_req, res) => {
        res.type('text/plain').send(
            `${SERVER_NAME} MCP server\n\n` +
            `MCP endpoint:      ${config.resourceUrl.href}\n` +
            `Protected resource: ${getOAuthProtectedResourceMetadataUrl(config.resourceUrl)}\n` +
            `Authorization server: ${config.publicUrl.origin}/.well-known/oauth-authorization-server\n`,
        );
    });

    return app;
}

/**
 * Minimal CORS for browser-based MCP clients. Requests without an `Origin`
 * (every native client) never reach this. `WWW-Authenticate` must be exposed
 * or the browser cannot read the 401 challenge that starts the OAuth flow.
 */
function cors(allowedOriginHostnames: string[]) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const origin = req.headers.origin;
        if (origin && allowedOriginHostnames.includes(safeHostname(origin) ?? '\0')) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
            res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, CompanyKey, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
            res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Method, Mcp-Name');
            res.setHeader('Access-Control-Max-Age', '86400');
        }
        if (req.method === 'OPTIONS') {
            res.status(204).end();
            return;
        }
        next();
    };
}

function safeHostname(origin: string): string | undefined {
    try {
        return new URL(origin).hostname;
    } catch {
        return undefined;
    }
}

# Unimicro MCP Server Template

A minimal, working [MCP](https://modelcontextprotocol.io) server for the
[Unimicro API](https://developer.unimicro.no), in TypeScript. Use it as the starting
point for your own: **Use this template**, add two credentials, `npm run dev`.

It speaks MCP revision **2026-07-28** — stateless Streamable HTTP, multi round-trip
requests, OAuth 2.1 — and ships exactly one tool, so there is nothing to delete before
you start writing your own.

> Points at Unimicro's **test** environment (`test-login.unimicro.no` /
> `test.unimicro.no`) by default.

Building this with an AI agent? Point it at [AGENTS.md](AGENTS.md).

---

## Quickstart

You need [Node.js 22+](https://nodejs.org) and a Unimicro test account. No database, no
Docker, no local certificates.

**1. Register an app** at [developer.unimicro.no](https://developer.unimicro.no/portal/applications),
add a client to it, and set the client's callback URL to exactly:

```
http://localhost:3000/oauth/callback
```

Either client type works — a **Mobile/native app** (public, no secret) or a
**Regular web app** (confidential, has a secret). The public one is less to manage.

Your app must also be **activated for the company you sign in with**. A brand-new app is
not, and the sign-in stops with *"Du har ikke tilgang til …"*. See
[docs/AUTH.md](docs/AUTH.md#before-anyone-can-sign-in).

**2. Install and configure:**

```bash
npm install && cp .env.example .env
```

Put the client id and secret from step 1 into `.env`.

**3. Run it:**

```bash
npm run dev
```

**4. Connect a client.** The MCP Inspector is the fastest way to see it work:

```bash
npx @modelcontextprotocol/inspector
```

Transport **Streamable HTTP**, URL `http://localhost:3000/mcp`, Connect. Sign in when
the browser opens, then call `check_api_access` — it reports which Unimicro companies
your account can reach, which confirms the whole chain works.

Claude Desktop, Claude Code and raw `curl`: [docs/CONNECTING.md](docs/CONNECTING.md).

---

## What's in the box

```
src/
├── index.ts             start the server
├── app.ts               wire up routes, auth, and the MCP handler
├── config.ts            every setting, read from the environment
├── auth/                the OAuth broker — read docs/AUTH.md before changing it
│   ├── broker.ts          /oauth/authorize, /callback, /token, /register
│   ├── clients.ts         how a calling MCP client proves its redirect URIs are its own
│   ├── verifier.ts        validating the bearer token on every request
│   └── store.ts           short-lived state, in memory
├── unimicro/api.ts      a thin typed wrapper over the Unimicro REST API
└── tools/               ← your code goes here
    ├── index.ts           the one-line registry
    ├── context.ts         what every tool is handed
    └── check-access.ts    the only tool: verify API access. Copy it.
```

`check_api_access` calls `GET /api/init/companies` and reports the API it reached, the
companies the user can act on, and which one other tools will default to. It exists to
prove the setup works and to be the shape you copy.

---

## Add your own tool

Write a file in `src/tools/`, add one line to `src/tools/index.ts`. That is the whole
registry — there is no reflection and nothing else to keep in sync.

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolContext } from './context.js';

export function registerInvoiceTools(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        'find_invoices',
        {
            title: 'Find invoices',
            description: 'List invoices for a company, newest first. Returns at most 50.',
            inputSchema: z.object({
                limit: z.number().int().min(1).max(50).default(10).describe('Maximum rows.'),
                companyKey: z.string().uuid().optional().describe('Which company. Omit unless told it is ambiguous.'),
            }),
            outputSchema: z.object({
                invoices: z.array(z.object({ id: z.number(), amount: z.number() })),
            }),
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async ({ limit, companyKey }) => {
            const company = await ctx.resolveCompanyKey(companyKey);
            const rows = await ctx.api.get<any[]>('api/biz/invoices', {
                companyKey: company,
                query: { top: limit, orderby: 'InvoiceDate desc' },
            });

            const invoices = rows.map(r => ({ id: r.ID, amount: r.TaxInclusiveAmount }));
            return {
                content: [{ type: 'text', text: `${invoices.length} invoices.` }],
                structuredContent: { invoices },
            };
        },
    );
}
```

[docs/ADDING-A-TOOL.md](docs/ADDING-A-TOOL.md) covers the rest: writing a description a
model actually follows, and making a write tool ask the user before it acts.

---

## Testing

```bash
npm test          # 37 tests
npm run typecheck
npm run build
```

The tests cover the OAuth broker's refusals, the discovery documents, and the tool over
real HTTP with the identity provider and Unimicro API stubbed. `test/mcp.test.ts` is the
clearest specification of the wire format — read it when a client misbehaves.

---

## Going to production

A few choices here are only right for a single instance against a test environment:

| What | Why it's fine here | What to change |
|---|---|---|
| Broker state in memory (`src/auth/store.ts`) | One process, short-lived state | Move to Redis for more than one replica |
| Registrations lost on restart | Clients re-register automatically | Persist them, or rely on CIMD only |
| Upstream tokens passed straight through | This server fronts the very API the token is for | Read [docs/AUTH.md](docs/AUTH.md) before fronting anything else |
| Test environment by default | Nothing real can break | Change `UNIMICRO_ISSUER` and `UNIMICRO_API_BASE_URL`, and re-register your app |

`PUBLIC_URL` must be HTTPS anywhere but localhost — the server refuses to start
otherwise, because an OAuth issuer over plain HTTP is not one.

A `Dockerfile` is included and needs nothing beyond the environment.

---

## License

MIT — see [LICENSE](LICENSE).

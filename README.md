# Unimicro MCP Server Template

A working [MCP](https://modelcontextprotocol.io) server for the
[Unimicro API](https://developer.unimicro.no), written in TypeScript. Use it as the
starting point for your own: **Use this template**, add two credentials, `npm run dev`.

It speaks MCP revision **2026-07-28** — stateless Streamable HTTP, multi round-trip
requests, OAuth 2.1 — and it ships three example tools you can read in one sitting.

> Everything here points at Unimicro's **test** environment
> (`test-login.unimicro.no` / `test.unimicro.no`) by default.

---

## Quickstart

You need [Node.js 22+](https://nodejs.org) and a Unimicro test account. No database, no
Docker, no local certificates.

**1. Register an app** at [developer.unimicro.no](https://developer.unimicro.no/portal/applications)
with this redirect URI:

```
http://localhost:5008/oauth/callback
```

**2. Install and configure:**

```bash
npm install && cp .env.example .env
```

Put the client id and secret from step 1 into `.env`.

**3. Run it:**

```bash
npm run dev
```

**4. Connect a client** — the MCP Inspector is the fastest way to see the tools:

```bash
npx @modelcontextprotocol/inspector
```

Choose transport **Streamable HTTP**, URL `http://localhost:5008/mcp`, and connect. You
will be sent to Unimicro to sign in, and land back on a list of three tools.

For Claude Desktop, Claude Code, and raw `curl`, see [docs/CONNECTING.md](docs/CONNECTING.md).

---

## What's in the box

```
src/
├── index.ts          start the server
├── app.ts            wire up routes, auth, and the MCP handler
├── config.ts         every setting, read from the environment
├── auth/             the OAuth broker — read docs/AUTH.md before changing it
│   ├── broker.ts       /oauth/authorize, /callback, /token, /register
│   ├── clients.ts      how a calling MCP client proves which redirect URIs are its own
│   ├── verifier.ts     validating the bearer token on every request
│   └── store.ts        short-lived state, in memory
├── unimicro/api.ts   a thin typed wrapper over the Unimicro REST API
└── tools/            ← your code goes here
    ├── index.ts        the one-line registry
    ├── context.ts      what every tool is handed
    ├── companies.ts    list_companies — the simplest possible tool
    └── customers.ts    find_customers (read) and create_customer (write + confirm)
```

Three tools ship by default:

| Tool | What it does |
|---|---|
| `list_companies` | The companies the signed-in user can act for |
| `find_customers` | Search customers by name, org. number, or customer number |
| `create_customer` | Create a customer — **asks the user to confirm first** |

---

## Add your own tool

Write a file in `src/tools/`, then add one line to `src/tools/index.ts`. The whole thing:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolContext } from './context.js';

export function registerInvoiceTools(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        'find_invoices',
        {
            title: 'Find invoices',
            description: 'List invoices for a company, newest first.',
            inputSchema: z.object({
                limit: z.number().int().min(1).max(50).default(10).describe('Maximum rows.'),
                companyKey: z.string().uuid().optional().describe('Which company. Omit unless told it is ambiguous.'),
            }),
            outputSchema: z.object({ invoices: z.array(z.object({ id: z.number(), amount: z.number() })) }),
            annotations: { readOnlyHint: true },
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

`docs/ADDING-A-TOOL.md` covers the rest: how to write a description a model actually
follows, when to use `outputSchema`, and how to make a write tool ask before it acts.

---

## Testing

```bash
npm test
```

38 tests cover the OAuth broker's refusals, the discovery documents, and every tool over
real HTTP with the identity provider and the Unimicro API stubbed. They are also the
clearest specification of the wire format — read `test/mcp.test.ts` if a client is
behaving oddly.

```bash
npm run typecheck
npm run build
```

---

## Going to production

This template is deliberately small, and a few of its choices are only right for a
single instance serving a test environment:

| What | Why it's fine here | What to change |
|---|---|---|
| Broker state in memory (`src/auth/store.ts`) | One process, short-lived state | Move to Redis for more than one replica |
| DCR registrations lost on restart | Clients re-register automatically | Persist them, or rely on CIMD only |
| Upstream tokens passed straight through | This server fronts the very API the token is for | Read [docs/AUTH.md](docs/AUTH.md) before fronting anything else |
| Test environment by default | Nothing real can break | Change `UNIMICRO_ISSUER` and `UNIMICRO_API_BASE_URL`, and re-register your app |

`PUBLIC_URL` must be HTTPS anywhere but localhost — the server refuses to start
otherwise, because an OAuth issuer over plain HTTP is not one.

A `Dockerfile` is included and needs no arguments beyond the environment.

---

## License

MIT — see [LICENSE](LICENSE).

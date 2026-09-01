# Unimicro MCP Server Template

A working [MCP](https://modelcontextprotocol.io) server for the
[Unimicro API](https://developer.unimicro.no), in TypeScript. **Use this template**, add
your credentials, `npm run dev`.

It speaks MCP revision **2026-07-28** — stateless Streamable HTTP, OAuth 2.1, multi
round-trip requests — and ships one tool, so there is nothing to delete before you start
writing your own.

Building with an AI agent? Point it at [AGENTS.md](AGENTS.md).

---

## Setup

You need [Node.js 22+](https://nodejs.org). No database, no Docker, no certificates.

### 1. Get a developer account

Sign up at **[dev-developer.unimicro.no](https://dev-developer.unimicro.no/portal/onboarding)**
— the GitHub button is the quickest way in. You get a developer licence, a test company,
and a **Demo application** to build on.

### 2. Set up the application

Open the Demo application → **Settings**, and do these in order:

1. Pick a **Category**. It is required, and saving does nothing until it is set.
2. Under **Access level**, expand **AppFramework** and tick `AppFramework`.
3. **Save changes.** The status next to the name should now read **Active**.

> **Order matters.** Set the access level *before* creating a client in the next step —
> a client only gets the scopes the application had when it was created.

### 3. Create a client

Still in **Settings** → **Authentication**, create either type:

| Type | Secret |
|---|---|
| **Mobile/native app** | none — one less thing to manage |
| **Regular web app** | yes |

Set the callback URL to exactly:

```
http://localhost:3000/oauth/callback
```

and the logout URL to `http://localhost:3000`. Copy the **client id** and, if you made a
web app, the **client secret** — the secret is shown only once.

### 4. Run it

```bash
npm install && cp .env.example .env
```

Paste the client id (and secret) into `.env`, then:

```bash
npm run dev
```

### 5. Connect

```bash
npx @modelcontextprotocol/inspector
```

Transport **Streamable HTTP**, URL `http://localhost:3000/mcp`, Connect. Sign in when the
browser opens, then call `check_api_access` — it lists the companies your account can
reach, which confirms the whole chain works.

Claude Desktop, Claude Code and raw `curl`: [docs/CONNECTING.md](docs/CONNECTING.md).

---

## What's in the box

```
src/
├── index.ts             start the server
├── app.ts               routes, auth, and the MCP handler
├── config.ts            every setting, read from the environment
├── auth/                the OAuth broker — see docs/AUTH.md
├── unimicro/api.ts      a thin typed wrapper over the Unimicro API
└── tools/               ← your code goes here
    ├── index.ts           the one-line registry
    ├── context.ts         what every tool is handed
    └── check-access.ts    the only tool. Copy it.
```

---

## Add your own tool

Write a file in `src/tools/`, add one line to `src/tools/index.ts`. That is the whole
registry.

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

[docs/ADDING-A-TOOL.md](docs/ADDING-A-TOOL.md) has the rest: descriptions a model
actually follows, and how a write tool asks the user before it acts.

---

## Testing

```bash
npm test          # 37 tests
npm run typecheck
npm run build
```

The tests run the whole server over real HTTP with the identity provider and the Unimicro
API stubbed. `test/mcp.test.ts` is the clearest spec of the wire format.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Sign-in ends on a Unimicro error page | The client's callback URL must be **exactly** `<PUBLIC_URL>/oauth/callback`. |
| `invalid_scope` during sign-in | `UNIMICRO_SCOPES` asks for something your client doesn't have. Match it to the client's scope list in the portal. |
| Saving the application does nothing | **Category** is empty. It is required. |
| Tools fail but sign-in worked | Your client is missing the `AppFramework` scope — set the access level, then recreate the client. |
| Server won't start, "must use https" | `PUBLIC_URL` is plain HTTP and not localhost. Correct — don't work around it. |
| Tool returns a list of companies | Working as intended. Pass one as `companyKey`. |

---

## Going to production

A few choices here suit a single instance against a test environment:

| What | Change for production |
|---|---|
| Broker state in memory (`src/auth/store.ts`) | Move to Redis for more than one replica |
| Registrations lost on restart | Persist them, or rely on CIMD only |
| Upstream tokens passed straight through | Read [docs/AUTH.md](docs/AUTH.md) before fronting anything else |

`PUBLIC_URL` must be HTTPS anywhere but localhost — the server refuses to start
otherwise, because an OAuth issuer over plain HTTP is not one. A `Dockerfile` is included.

---

## License

MIT — see [LICENSE](LICENSE).

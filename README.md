# Unimicro MCP Server Template

A working [MCP](https://modelcontextprotocol.io) server for the
[Unimicro API](https://developer.unimicro.no/guide/endpoints/), in TypeScript. Speaks MCP revision
**2026-07-28** and ships one tool, so there is nothing to delete before you start writing
your own.

```bash
git clone https://github.com/unimicro/Unimicro.MCP.git
cd Unimicro.MCP
```

Building with an AI agent? Point it at [AGENTS.md](AGENTS.md).

---

## Which environment am I in?

Unimicro runs several environments. Each is a **matched set** — portal, login and API —
and mixing them across sets is the single easiest way to lose an hour, because everything
looks fine until sign-in fails with an error that never mentions environments.

| | Portal (register here) | Login | API |
|---|---|---|---|
| **dev** ← this template's default | `dev-developer.unimicro.no` | `dev-login.unimicro.no` | `dev.unimicro.no` |
| **test** | `developer.unimicro.no` | `test-login.unimicro.no` | `test.unimicro.no` |

Both portals render the same page title and both hostnames answer normally, so a wrong
one gives you no signal at all. **Register in the portal on the same row as the login
host you are pointing at.** This template defaults to dev; to use test instead, set
`UNIMICRO_ISSUER` and `UNIMICRO_API_BASE_URL` together.

Production hostnames differ again. Don't point a fork there without reading
[docs/AUTH.md](docs/AUTH.md).

---

## Setup

You need [Node.js 22+](https://nodejs.org). No database, no Docker, no certificates.

### 1. Get a developer account

Sign up at **[dev-developer.unimicro.no](https://dev-developer.unimicro.no/portal/onboarding)**
using the GitHub button. Provisioning is immediate — no email, no waiting for approval —
and you end up with a developer licence, a test company, and a **Demo application** to
build on.

### 2. Set up the application

Open the Demo application → **Settings**, in this order:

1. Pick a **Category**. It is required, and saving does nothing until it is set.
2. Under **Access level**, expand **AppFramework** and tick `AppFramework`.
3. **Save changes.** The status by the name should now read **Active**.

> **Order matters.** Set the access level *before* creating a client in the next step —
> a client only gets the scopes the application had when it was created.

### 3. Create a client

Still in **Settings** → **Authentication**. **Pick Mobile/native app** unless you know you
want a secret to manage — it is a public client and authenticates with PKCE alone. A
Regular web app also works and gives you a client secret.

Set the callback URL to exactly:

```
http://localhost:3000/oauth/callback
```

and the logout URL to `http://localhost:3000`. Copy the **client id**, and the **client
secret** if you made a web app — the secret is shown only once.

> **Prefer port 3000.** Everything else follows `PORT` automatically, but the callback URL
> is registered on the client and Unimicro will only redirect to a registered one — so a
> different port also means editing the client in the portal. If you were handed a client
> rather than making your own, you cannot change it, and sign-in will fail on an opaque
> error page. If 3000 is busy, free it: the server now refuses to start and names the
> process holding it.

### 4. Run it

```bash
npm install
cp -n .env.example .env    # -n so a re-run can't clobber a secret you already pasted
```

Put the client id (and secret) in `.env`, then:

```bash
npm run dev
```

The first line of output mentions `dangerouslyAllowInsecureIssuerUrl`. That is expected on
localhost and nothing is wrong — see [docs/AUTH.md](docs/AUTH.md).

### 5. Connect

```bash
npx @modelcontextprotocol/inspector
```

First run downloads for ~40 s and may print a deprecation warning that has nothing to do
with this repo. In the Inspector (v2.4.0), you land on a **Servers** dashboard with demo
servers already listed — click **Add Servers → + Add manually**, then choose transport
**Streamable HTTP** and URL `http://localhost:3000/mcp`, and Connect.

Sign in when the browser opens, then call `check_api_access` — it lists the companies your
account can reach, which confirms the whole chain works.

Need a bearer token for `curl` or a script? `npm run token` prints a sign-in URL and hands
you one.

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

**What you can call is documented at
[developer.unimicro.no/guide/endpoints](https://developer.unimicro.no/guide/endpoints/)** —
customers, invoices, products, orders, journal entries and more. The API returns `401` for
unknown paths as well as real ones, so read the page rather than probing.

[docs/ADDING-A-TOOL.md](docs/ADDING-A-TOOL.md) has the rest: descriptions a model actually
follows, and how a write tool asks the user before it acts.

---

## Testing

```bash
npm test          # 42 tests
npm run token     # a bearer token, for curl and scripts
npm run typecheck
npm run build
```

The tests run the whole server over real HTTP with the identity provider and the Unimicro
API stubbed. `test/mcp.test.ts` is the clearest spec of the wire format.

---

## Troubleshooting

This is the only troubleshooting table in the repo; the other docs link here.

| Symptom | Cause |
|---|---|
| First line of startup says `dangerouslyAllowInsecureIssuerUrl` | Expected on localhost. Not a misconfiguration. |
| `401` from `/mcp` | Expected without a token. Sign in through your client. |
| Sign-in ends on a Unimicro error page | The client's callback URL must be **exactly** `<PUBLIC_URL>/oauth/callback`. |
| `invalid_scope` during sign-in | `UNIMICRO_SCOPES` asks for something your client doesn't have. Match it to the client's scope list in the portal. |
| Sign-in works, tools fail | The client is missing the `AppFramework` scope. Set the access level, then recreate the client — a client keeps the scopes it was born with. |
| Sign-in fails and nothing above fits | Environment mismatch. Decode your token at [jwt.io](https://jwt.io) and read `aud` — it names the environment. Compare with the table at the top. |
| Saving the application does nothing | **Category** is empty. It is required. |
| Your client must sign in again every hour | Tokens last one hour and no refresh token is issued by default. See `UNIMICRO_SCOPES` in `.env.example`. |
| `Unknown client_id` on `/oauth/authorize` | The MCP client registered before a restart. Registrations are in memory — reconnect it. |
| `403` on `/mcp` from a browser client | Its origin isn't allowed. Add it to `ALLOWED_ORIGINS`. |
| Server won't start, port in use | Something else holds it. The error names the PID; stop it, or free the port — see the note in step 3 before changing `PORT`. |
| Server won't start, "must use https" | `PUBLIC_URL` is plain HTTP and not localhost. Correct — don't work around it. |
| Tool returns a list of companies | Working as intended. Pass one as `companyKey`. |

---

## Going to production

`PUBLIC_URL` must be HTTPS anywhere but localhost — the server refuses to start otherwise.
Broker state is in memory, so move `src/auth/store.ts` to Redis before running more than
one replica. Read [docs/AUTH.md](docs/AUTH.md) first: it explains the one deliberate spec
deviation and when it stops being safe. A `Dockerfile` is included.

---

## License

MIT — see [LICENSE](LICENSE).

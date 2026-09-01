# AGENTS.md

Instructions for an AI agent working in this repository.

## What this is

An MCP server template for the Unimicro API. TypeScript, Node 22+, Express, MCP revision
**2026-07-28** via `@modelcontextprotocol/server` v2.

There is no database, no Docker and no local TLS. If you find yourself adding any of them
to make something work, you have taken a wrong turn.

## Setup

```bash
npm install
cp .env.example .env
```

Then fill in `.env`:

| Variable | Where it comes from |
|---|---|
| `UNIMICRO_CLIENT_ID` | A client on an application in the developer portal |
| `UNIMICRO_CLIENT_SECRET` | Same client, only if it is a "Regular web app". Blank for "Mobile/native app". |

**You cannot create these yourself** — they need a human with a Unimicro developer
account. Ask for them rather than guessing. The README documents the sign-up if the user
has not done it yet; the order there matters (access level before client), so point them
at it rather than improvising.

## Run

```bash
npm run dev     # watch mode on http://localhost:3000
npm start       # requires npm run build first
curl -s http://localhost:3000/health
```

## Verify

Run all three before claiming anything works:

```bash
npm run typecheck
npm test
npm run build
```

`npm test` needs no credentials — the identity provider and the Unimicro API are stubbed.
It is the fastest check that you have not broken the protocol layer.

To check the server end to end without a browser, confirm the OAuth discovery chain:

```bash
curl -si -X POST http://localhost:3000/mcp -H 'content-type: application/json' -d '{}' | head -3
curl -s http://localhost:3000/.well-known/oauth-protected-resource/mcp
curl -s http://localhost:3000/.well-known/oauth-authorization-server
```

The first must return `401` with a `WWW-Authenticate` header naming the second URL.

Calling a tool needs a real access token, which needs a browser sign-in. **Do not try to
automate the OAuth flow.** Ask the user to sign in through the MCP Inspector
(`npx @modelcontextprotocol/inspector`, Streamable HTTP, `http://localhost:3000/mcp`).

## Layout

| Path | What it holds |
|---|---|
| `src/index.ts` | Entry point. Loads config, starts listening. |
| `src/app.ts` | All routing and wiring. Start here. |
| `src/config.ts` | Every setting. Add new ones here, never read `process.env` elsewhere. |
| `src/auth/` | The OAuth broker. Read `docs/AUTH.md` before touching it. |
| `src/unimicro/api.ts` | Typed wrapper over the Unimicro API. |
| `src/tools/` | The tools. Feature work goes here. |
| `test/` | Vitest suites over real HTTP with outbound calls stubbed. |

## Adding a tool

1. Create `src/tools/<name>.ts` exporting `register<Name>Tools(server, ctx)`.
2. Add one line to `registerTools()` in `src/tools/index.ts`.
3. Add a test to `test/mcp.test.ts`.

Copy `src/tools/check-access.ts` — it is the reference shape. `docs/ADDING-A-TOOL.md` has
the rules that matter: describe every parameter, constrain in the zod schema rather than
in prose, declare `outputSchema`, resolve the company through `ctx.resolveCompanyKey()`,
and confirm writes with `inputRequired()`.

## Rules

- **Never read `process.env` outside `src/config.ts`.** Settings are parsed once, typed
  and validated at startup.
- **Do not weaken the broker to make a client work.** Every refusal in `src/auth/broker.ts`
  has a test and a reason in `docs/AUTH.md`. A failing client is usually the client, or a
  `PUBLIC_URL` that does not match the registered callback URL.
- **Do not add an unauthenticated MCP endpoint.** Not for testing, not behind a flag.
- **Do not commit `.env`.**
- **Return both `content` and `structuredContent`** from every tool, and keep the text
  short — it is tokens on every call.
- **Throw errors written for the model to read.** `'No customer 1234. Use find_customers
  to look one up by name.'`, not `'Request failed'`.
- **Match the surrounding style.** Four-space indent, named exports, `.js` extensions on
  relative imports (required by NodeNext ESM).

## Common failures

| Symptom | Cause |
|---|---|
| Server exits with `Invalid configuration` | `.env` missing or incomplete. The message names the variable. |
| `Parse error: Invalid JSON` from `/mcp` | Request is missing the `_meta` envelope, or `Content-Type` is not `application/json`. |
| Sign-in ends on a Unimicro error page | The client's callback URL is not exactly `<PUBLIC_URL>/oauth/callback`. |
| `invalid_scope` during sign-in | `UNIMICRO_SCOPES` asks for a scope the client does not have. |
| Tools fail after a successful sign-in | The client is missing the `AppFramework` scope. Not fixable in code. |
| `Unknown client_id` on `/oauth/authorize` | The MCP client registered before a restart. Registrations are in memory; reconnect it. |
| Server refuses to start, "must use https" | `PUBLIC_URL` is plain HTTP and not localhost. Correct — do not work around it. |
| Tool reports several companies | Working as intended. Pass one as `companyKey`. |

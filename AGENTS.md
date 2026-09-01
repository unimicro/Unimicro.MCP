# AGENTS.md

Instructions for an AI agent working in this repository.

## What this is

An MCP server template for the Unimicro API. TypeScript, Node 22+, Express, MCP
revision **2026-07-28** via `@modelcontextprotocol/server` v2.

There is no database, no Docker and no local TLS. If you find yourself adding any of
them to make something work, you have taken a wrong turn.

## Setup

```bash
npm install
cp .env.example .env
```

Then edit `.env` and set two values:

| Variable | Where it comes from |
|---|---|
| `UNIMICRO_CLIENT_ID` | A client on an app registered at https://developer.unimicro.no/portal/applications |
| `UNIMICRO_CLIENT_SECRET` | The same client, if it is a "Regular web app". Leave blank for a "Mobile/native app" — that type is a public client and authenticates with PKCE alone. |

**The client's callback URL must be exactly `http://localhost:3000/oauth/callback`.** A
mismatch is the most common failure and Unimicro's error message for it is unhelpful.

**The app must also be activated for the company being signed in with.** A newly created
app is not, and sign-in stops at *"Du har ikke tilgang til …"*. This is not something you
can fix in code or in the portal alone — see docs/AUTH.md.

You cannot register the app yourself — it needs a human with a Unimicro account. Ask for
the two credentials rather than guessing.

## Run

```bash
npm run dev     # watch mode on http://localhost:3000
npm start       # requires npm run build first
```

Confirm it is up:

```bash
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
It is the fastest way to check you have not broken the protocol layer.

To check the server end to end without a browser, confirm the OAuth discovery chain:

```bash
curl -si -X POST http://localhost:3000/mcp -H 'content-type: application/json' -d '{}' | head -3
curl -s http://localhost:3000/.well-known/oauth-protected-resource/mcp
curl -s http://localhost:3000/.well-known/oauth-authorization-server
```

The first must return `401` with a `WWW-Authenticate` header naming the second URL.

Calling a tool needs a real access token, which needs a browser sign-in. Do not try to
automate the OAuth flow; ask a human to sign in through the MCP Inspector
(`npx @modelcontextprotocol/inspector`, Streamable HTTP, `http://localhost:3000/mcp`)
and hand you the token if you need one.

## Layout

| Path | What it holds |
|---|---|
| `src/index.ts` | Entry point. Loads config, starts listening. |
| `src/app.ts` | All routing and wiring. Start here to understand the server. |
| `src/config.ts` | Every setting. Add new ones here, never read `process.env` elsewhere. |
| `src/auth/` | The OAuth broker. Read `docs/AUTH.md` before touching it. |
| `src/unimicro/api.ts` | Typed wrapper over the Unimicro REST API. |
| `src/tools/` | The tools. This is where feature work goes. |
| `test/` | Vitest suites over real HTTP with outbound calls stubbed. |

## Adding a tool

1. Create `src/tools/<name>.ts` exporting `register<Name>Tools(server, ctx)`.
2. Add one line to `registerTools()` in `src/tools/index.ts`.
3. Add a test to `test/mcp.test.ts`.

Copy `src/tools/check-access.ts` — it is the reference shape. Read
`docs/ADDING-A-TOOL.md` for the rules that matter: describing every parameter,
constraining in the zod schema rather than in prose, declaring `outputSchema`, resolving
the company through `ctx.resolveCompanyKey()`, and confirming writes with
`inputRequired()`.

## Rules

- **Do not read `process.env` outside `src/config.ts`.** Settings are parsed once, typed,
  and validated at startup.
- **Do not weaken the broker to make a client work.** Every refusal in `src/auth/broker.ts`
  has a test and a reason in `docs/AUTH.md`. If a client fails, the client is usually
  wrong, or `PUBLIC_URL` does not match the registered redirect URI.
- **Do not add an unauthenticated MCP endpoint.** Not for testing, not behind a flag.
- **Do not commit `.env`.** It is gitignored; keep it that way.
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
| Sign-in shows "Du har ikke tilgang til \<app\>" | The app is not activated for that company. Not a code problem — see docs/AUTH.md. |
| `Unknown client_id` on `/oauth/authorize` | Client registered before a restart. Registrations are in memory; reconnect the client. |
| Server refuses to start, "must use https" | `PUBLIC_URL` is plain HTTP and not localhost. Correct — do not work around it. |
| Tool reports several companies | Working as intended. Pass one as `companyKey`. |

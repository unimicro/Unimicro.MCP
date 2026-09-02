# AGENTS.md

Instructions for an AI agent working in this repository.

## What this is

An MCP server template for the Unimicro API. TypeScript, Node 22+, Express, MCP revision
**2026-07-28** via `@modelcontextprotocol/server` v2.

It needs no database and no local TLS, and nothing runs in a container during development.
If you find yourself reaching for any of those to make something work, you have taken a
wrong turn. (A `Dockerfile` exists for deployment; it is not part of the dev loop.)

## Setup

```bash
npm install
cp -n .env.example .env
```

Then fill in `.env`:

| Variable | Where it comes from |
|---|---|
| `UNIMICRO_CLIENT_ID` | A client on an application in the developer portal |
| `UNIMICRO_CLIENT_SECRET` | Same client, only if it is a "Regular web app". Blank for "Mobile/native app". |
| `UNIMICRO_ENV` | `test` (default) or `dev`. Sets identity and API together. Must match the portal the credentials came from — `test` is developer.unimicro.no, which is where an external developer signs up. |

**You cannot create these yourself** — they need a human with a Unimicro developer
account. Ask for them rather than guessing.

Two things about that request are worth getting right, because both are invisible until
sign-in fails:

Point them at the README rather than improvising: it has the environment table and the
step order that matters (access level before client). Both failures are invisible until
sign-in. When asking for credentials, say which environment you want them for — they are
not interchangeable.

## Run

```bash
npm run dev     # watch mode; PUBLIC_URL follows PORT, so changing PORT is safe
npm start       # requires npm run build first
curl -s http://localhost:3000/health
```

The first startup line mentions `dangerouslyAllowInsecureIssuerUrl`. Expected on
localhost. Do not "fix" it.

## Verify

Run all three before claiming anything works:

```bash
npm run typecheck
npm test
npm run build
```

`npm test` needs no credentials — the identity provider and the Unimicro API are stubbed.
It is the fastest check that you have not broken the protocol layer.

To exercise the OAuth discovery chain by hand, use the curls in
[docs/CONNECTING.md](docs/CONNECTING.md). For a bearer token, run `npm run token` — it
prints a URL for the user to sign in with and then prints the token. Do not write your own
OAuth client.

Calling a tool needs a real access token, which needs a browser sign-in. **Do not try to
automate the OAuth flow.** Ask the user to sign in through the MCP Inspector — the README
has the steps, including the two clicks the Inspector needs before it shows a URL field.

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

What to call is documented at
[developer.unimicro.no/guide/endpoints](https://developer.unimicro.no/guide/endpoints/).
The API answers `401` for unknown paths too, so you cannot find an endpoint by probing —
read the page.

Copy `src/tools/check-access.ts` — it is the reference shape. `docs/ADDING-A-TOOL.md` has
the rules that matter: describe every parameter, constrain in the zod schema rather than in
prose, declare `outputSchema`, resolve the company through `ctx.resolveCompanyKey()`, and
confirm writes with `inputRequired()`.

## Rules

- **Never read `process.env` outside `src/config.ts`.** Settings are parsed once, typed and
  validated at startup. A tool that needs a new setting adds it to the schema there and
  reads it from `Config` — no exceptions, including for secrets.
- **Do not weaken the broker to make a client work.** Every refusal in `src/auth/broker.ts`
  has a test and a reason in `docs/AUTH.md`. A failing client is usually the client, a
  callback URL that does not match, or the wrong environment.
- **Do not add an unauthenticated MCP endpoint.** Not for testing, not behind a flag.
- **Do not commit `.env`.**
- **Return both `content` and `structuredContent`** from every tool, and keep the text
  short — it is tokens on every call. Never repeat in the text what is already in
  `structuredContent`.
- **Throw errors written for the model to read.** `'No customer 1234. Use find_customers to
  look one up by name.'`, not `'Request failed'`.
- **Match the surrounding style.** Four-space indent, named exports, `.js` extensions on
  relative imports (required by NodeNext ESM).

## When something breaks

The README has the troubleshooting table, and it is the only one — do not duplicate it
here. Two entries matter most to you, because neither is fixable in code:

- **Sign-in works but tools fail** → the client is missing the `AppFramework` scope.
- **Sign-in fails for no visible reason** → decode the token's `aud` claim; it names the
  environment, and a mismatch with the configured issuer is the usual cause.

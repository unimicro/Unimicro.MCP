# How authentication works

This server is both an OAuth **resource server** (it validates tokens on `/mcp`) and an
OAuth **authorization server** (MCP clients sign in through it). The second role exists
because of a mismatch, and that mismatch explains the whole `src/auth/` directory.

## Why the broker exists

An MCP client — Claude Desktop, the Inspector, something you wrote — expects to walk up to
a server it has never seen, register itself, and run a PKCE authorization code flow as a
public client.

Unimicro's identity provider allows neither: applications are registered by hand in the
developer portal, and their callback URLs are fixed at registration time.

So this server stands in the middle. **Downstream** it is an authorization server any MCP
client can register with. **Upstream** it is your one registered application.

```
MCP client                  this server                   Unimicro identity
    │                            │                                 │
    │  GET /oauth/authorize      │                                 │
    ├───────────────────────────▶│  redirect, your client_id       │
    │                            ├────────────────────────────────▶│
    │                            │                                 │  user signs in
    │                            │◀────────────────────────────────┤
    │                            │  GET /oauth/callback            │
    │◀───────────────────────────┤  redirect with our code         │
    │  POST /oauth/token         │                                 │
    ├───────────────────────────▶│  exchange upstream code         │
    │                            ├────────────────────────────────▶│
    │◀───────────────────────────┤  access token                   │
```

Two OAuth flows back to back, joined by a transaction that lives for five minutes in
`src/auth/store.ts`.

## Client types

Two portal client types suit this server:

| Type | Secret | Notes |
|---|---|---|
| **Mobile/native app** | none | Public client — PKCE alone authenticates it. Leave `UNIMICRO_CLIENT_SECRET` blank. |
| **Regular web app** | yes | Confidential client. Set the secret too. |

The broker sends `client_secret` upstream only when one is configured, so both work
unchanged.

## Token lifetime

Tokens last one hour, and **no refresh token is issued under the default scopes**. The
broker implements the `refresh_token` grant and advertises it, but Unimicro only returns a
refresh token when `offline_access` is requested — and your client must carry that scope
for the request to be legal. Add it to both, or expect a fresh browser sign-in each hour.

Setup problems and what they look like live in the
[README troubleshooting table](../README.md#troubleshooting), which is the only one in the
repo.

## What a client discovers

Everything starts from a `401`:

```
WWW-Authenticate: Bearer error="invalid_token",
                  resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"
```

| Document | Serves |
|---|---|
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 — this resource and its authorization server |
| `/.well-known/oauth-authorization-server` | RFC 8414 — authorize, token and registration endpoints |

Both come from the SDK's `mcpAuthMetadataRouter`; the content comes from
`authorizationServerMetadata()` in `src/auth/broker.ts`.

## How a client identifies itself

**Client ID Metadata Documents** — the `client_id` *is* an HTTPS URL serving its own
metadata. Nothing registered, nothing to expire. This is the path MCP 2026-07-28 prefers.

Fetching a URL an unauthenticated caller chose is a server-side request forgery primitive,
so `fetchClientIdMetadata()` in `src/auth/clients.ts` insists on HTTPS, no redirects, a
publicly routable address, a 5-second timeout, a 64 KB cap, and a document that names the
same `client_id` we asked for.

**Dynamic Client Registration** — `POST /oauth/register` returns an opaque id. Deprecated
in 2026-07-28, kept because clients in the field still use it. Registrations live in
memory for a week and vanish on restart, at which point clients re-register on their own.

## What the broker refuses

Each has a test in `test/broker.test.ts`:

- An unknown `client_id`, or a `redirect_uri` the client never registered — rendered as an
  error page, never a redirect, because redirecting to an unproven URI *is* the open
  redirect.
- A request without PKCE, or `code_challenge_method` other than `S256`.
- A `resource` (RFC 8707) naming some other server.
- A callback whose `state` we did not issue, or already consumed.
- A callback whose `iss` is not Unimicro (RFC 9207 mix-up defence).
- A token request whose PKCE verifier, `client_id` or `redirect_uri` does not match.
- A second use of an authorization code.

Each leg gets its **own** PKCE pair and **own** `state`. Nothing the client chooses is
forwarded upstream, and nothing upstream returns is forwarded to the client.

## Token validation

`src/auth/verifier.ts` validates the bearer token on every `/mcp` request against
Unimicro's JWKS — locally, with `jose` caching and rotating keys. No introspection call on
the hot path.

### The audience caveat — read this before forking

MCP 2026-07-28 says a resource server **MUST** reject tokens not issued for itself.
Unimicro issues tokens audienced to its own API resource and does not implement RFC 8707
resource indicators, so no token will ever carry this server's URL in `aud`. Decode a real
one and you see:

```json
{
  "iss": "https://dev-login.unimicro.no",
  "aud": ["AppFramework", "https://dev-login.unimicro.no/resources"],
  "client_id": "…", "sub": "…", "exp": 1788262034
}
```

No `http://localhost:3000/mcp` anywhere, and no way to ask for one. This server therefore
accepts the upstream audience.

That `aud` is also the fastest way to tell which environment a token came from — useful
when a sign-in fails for no visible reason.

That is safe **here** for one reason: this server is a facade over the very API the token
was minted for. It cannot let a token do anything its holder could not already do by
calling the API directly. There is no privilege to escalate.

**It stops being safe the moment that is no longer true.** If you fork this to front a
different API, or to add capabilities Unimicro does not grant, mint your own tokens: issue
a short-lived JWT at `/oauth/token` audienced to your resource URL, and keep the upstream
token server-side keyed by its `jti`. Until then, any Unimicro token from anywhere is a
valid credential for your server.

## Configuration

| Variable | Meaning |
|---|---|
| `PUBLIC_URL` | This server's public origin. It is the OAuth issuer identifier and the base of every advertised URL, so it must match what clients dial, port included. HTTPS required off localhost. |
| `UNIMICRO_CLIENT_ID` | The client on your application in the developer portal. |
| `UNIMICRO_CLIENT_SECRET` | Only for a confidential client. Upstream-only; it never leaves the server. |
| `UNIMICRO_ISSUER` | The identity provider. |
| `UNIMICRO_SCOPES` | What to request upstream. Must be a subset of your client's scopes. |

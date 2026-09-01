# How authentication works

This server is both an OAuth **resource server** (it validates tokens on `/mcp`) and an
OAuth **authorization server** (MCP clients sign in through it). The second role exists
only because of a mismatch, and understanding that mismatch is the key to the whole
directory.

## Before anyone can sign in

Two things must be true on Unimicro's side, and neither is visible from the code:

1. **The client's callback URL is exactly `<PUBLIC_URL>/oauth/callback`.** Anything else
   ends the sign-in on a Unimicro error page.
2. **The app is activated for the company the user signs in with.** A newly registered
   app is not. The sign-in reaches Unimicro, the user is recognised, and then it stops
   with *"Du har ikke tilgang til &lt;app&gt; — produktet du prøver å aktivere er ikke
   tilgjengelig for ditt/dine selskap."*

The second one catches everybody. Creating a release draft and setting *Initial purchase
status* to Active does **not** clear it: the app has to actually reach the company's
marketplace (Markedsplass → Integrasjoner), which for a new app means going through
Unimicro's publishing review. Until then the app works for nobody, and no amount of
configuration on this side changes that.

If you are inside Unimicro, ask the platform team to provision the app for your test
company. If you are external, use an app that is already activated.

## Client types

Unimicro offers several client types on an app; two suit this server:

| Type | Secret | Notes |
|---|---|---|
| **Mobile/native app** | none | A public client: PKCE alone authenticates it. Leave `UNIMICRO_CLIENT_SECRET` blank. Less to store and rotate. |
| **Regular web app** | yes | A confidential client. Set `UNIMICRO_CLIENT_SECRET` too. |

The broker sends `client_secret` upstream only when one is configured, so both work
unchanged. Unimicro's own MCP server uses the public variety.

## The mismatch

An MCP client — Claude Desktop, the Inspector, something you wrote — expects to walk up
to a server it has never seen and:

1. register itself, then
2. run a PKCE authorization code flow as a public client.

Unimicro's identity provider allows neither. Apps are registered by hand at
developer.unimicro.no and their callback URLs are fixed at registration time.

So this server stands in the middle. **Downstream** it is an authorization server that
any MCP client can register with and use. **Upstream** it is one pre-registered
confidential client with one fixed redirect URI.

```
MCP client                  this server                   test-login.unimicro.no
    │                            │                                 │
    │  GET /oauth/authorize      │                                 │
    ├───────────────────────────▶│  redirect, our client_id,       │
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

Two OAuth flows, back to back, joined by a transaction record that lives for five
minutes in `src/auth/store.ts`.

## What a client discovers

Everything starts from a `401`:

```
WWW-Authenticate: Bearer error="invalid_token",
                  resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"
```

| Document | Serves |
|---|---|
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 — this resource, and which authorization server to use |
| `/.well-known/oauth-authorization-server` | RFC 8414 — the authorize, token, and registration endpoints |

Both come from the SDK's `mcpAuthMetadataRouter`; the content comes from
`authorizationServerMetadata()` in `src/auth/broker.ts`.

## How a client identifies itself

Two ways, both supported:

**Client ID Metadata Documents** — the client's `client_id` *is* an HTTPS URL serving its
own metadata. Nothing is registered and nothing expires. This is the path MCP 2026-07-28
prefers.

Fetching a URL an unauthenticated caller chose is a server-side request forgery
primitive, so `fetchClientIdMetadata()` in `src/auth/clients.ts` insists on: HTTPS, no
redirects, a publicly routable address (no loopback, private range, or cloud metadata
endpoint), a 5-second timeout, a 64 KB body cap, and a document that names the same
`client_id` we asked for.

**Dynamic Client Registration (RFC 7591)** — `POST /oauth/register` returns an opaque id.
Formally deprecated in 2026-07-28; kept because clients in the field still use it.
Registrations live in memory for a week and vanish on restart, at which point clients
re-register on their own.

## What the broker refuses

Each of these has a test in `test/broker.test.ts`:

- An unknown `client_id`, or a `redirect_uri` the client never registered — rendered as
  an error page, never a redirect, because redirecting to an unproven URI *is* the open
  redirect.
- A request without PKCE, or with `code_challenge_method` other than `S256`.
- A `resource` (RFC 8707) naming some other server.
- A callback whose `state` we did not issue, or that we already consumed.
- A callback whose `iss` is not Unimicro (RFC 9207 — Unimicro advertises
  `authorization_response_iss_parameter_supported`, so a missing or wrong `iss` is a
  mix-up attack, not a quirk).
- A token request whose PKCE verifier, `client_id`, or `redirect_uri` doesn't match the
  authorization request.
- A second use of an authorization code.

The downstream and upstream legs each get their **own** PKCE pair and their **own**
`state`. Nothing the client chooses is forwarded to Unimicro, and nothing Unimicro
returns is forwarded to the client.

## Token validation

`src/auth/verifier.ts` validates the bearer token on every `/mcp` request against
Unimicro's JWKS — locally, with `jose` caching and rotating keys. No introspection call
on the hot path.

### The audience caveat — read this before forking

MCP 2026-07-28 says a resource server **MUST** reject tokens not issued for itself.
Unimicro issues tokens audienced to its own API resource and does not implement RFC 8707
resource indicators, so no token will ever carry this server's URL in `aud`. This server
therefore accepts the upstream audience.

That is safe **here** for one specific reason: this server is a facade over the very API
the token was minted for. It cannot let a token do anything its holder could not already
do by calling `test.unimicro.no` directly. There is no privilege to escalate.

**It stops being safe the moment that is no longer true.** If you fork this to front a
different API, or to add capabilities Unimicro itself does not grant, you must issue your
own tokens: mint a short-lived JWT of your own at `/oauth/token`, audienced to your
resource URL, and keep the Unimicro token server-side keyed by that JWT's `jti`. Until
you do, any Unimicro token from anywhere is a valid credential for your server.

## Configuration

| Variable | Meaning |
|---|---|
| `PUBLIC_URL` | This server's public origin. It is the OAuth issuer identifier and the base of every advertised URL, so it must match what clients dial, port included. HTTPS required off localhost. |
| `UNIMICRO_CLIENT_ID` | The client on your app from developer.unimicro.no. |
| `UNIMICRO_CLIENT_SECRET` | Only for a confidential ("Regular web app") client. Upstream-only; it never leaves the server. Blank for a public client. |
| `UNIMICRO_ISSUER` | The identity provider. `https://test-login.unimicro.no` by default. |
| `UNIMICRO_SCOPES` | What to request upstream. Trim to least privilege. |

The callback URL you register upstream must be exactly `<PUBLIC_URL>/oauth/callback`.
Getting this wrong is the single most common setup failure, and Unimicro's error for it
is unhelpful.

# Connecting a client

The server speaks **stateless Streamable HTTP** at `http://localhost:3000/mcp` and acts
as its own OAuth authorization server in front of Unimicro's identity provider, so every
client below signs in the same way: it discovers the authorization server from a `401`,
sends you to Unimicro, and comes back with a token.

| | |
|---|---|
| MCP endpoint | `http://localhost:3000/mcp` |
| Protected resource metadata | `http://localhost:3000/.well-known/oauth-protected-resource/mcp` |
| Authorization server metadata | `http://localhost:3000/.well-known/oauth-authorization-server` |
| Health | `http://localhost:3000/health` |

No TLS certificate is needed locally — the server runs on plain HTTP on localhost, which
is the one place an OAuth issuer may do so.

## MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

First run downloads for ~40 s and may print a deprecation warning unrelated to this repo.

The Inspector (v2.4.0) opens on a **Servers** dashboard with demo servers already listed —
there is no URL field on that screen. Click **Add Servers → + Add manually**, then set
transport **Streamable HTTP** and URL `http://localhost:3000/mcp`, and Connect.

Sign in when the browser opens, then call `check_api_access` — it reports which companies
your account can reach, which confirms the whole chain works.

> The Inspector's own OAuth callback is on `localhost:6274`, not `localhost:3000`. That is
> correct and nothing to fix: those are two different legs. `localhost:6274` is where
> **this server** sends the Inspector back, and this server accepts any redirect URI the
> client registered with it. `<PUBLIC_URL>/oauth/callback` is the separate leg where
> **Unimicro** sends this server back, and that one must match the portal exactly.

## Claude Code

```bash
claude mcp add --transport http unimicro http://localhost:3000/mcp
```

## Claude Desktop

Add to `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "unimicro": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3000/mcp", "--transport", "http-only"]
    }
  }
}
```

Quit Claude Desktop completely, reopen it, and complete the sign-in in the browser.

## Choosing a company

Most tools need to know which company they are acting on. In order of precedence:

1. a `companyKey` argument on the tool call,
2. a `CompanyKey` HTTP header, which a host application that already knows the company
   should set,
3. automatic, when the user has exactly one company.

When none applies, the tool returns an error listing the available companies, and the
model picks one.

## Calling it with curl

Useful when a client is misbehaving and you want to see the wire.

First get a token — you need a real one, and hand-rolling a PKCE client to obtain it is a
detour nobody should repeat:

```bash
npm run token
```

It prints a sign-in URL, waits while you sign in, and prints a bearer token valid for about
an hour. Then:

```bash
export TOKEN='paste-it-here'
```

The 2026-07-28 revision is strict: routing headers on the outside, a `_meta` envelope on
the inside.

```bash
curl -sN -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientInfo":{"name":"curl","version":"1.0.0"},
        "io.modelcontextprotocol/clientCapabilities":{}}}}'
```

Calling a tool adds an `Mcp-Name` header naming it:

```bash
curl -sN -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/call' \
  -H 'Mcp-Name: check_api_access' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
        "name":"check_api_access","arguments":{},
        "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
                 "io.modelcontextprotocol/clientInfo":{"name":"curl","version":"1.0.0"},
                 "io.modelcontextprotocol/clientCapabilities":{}}}}'
```

Responses usually come back as a single JSON body. They arrive as an SSE frame instead
when the handler emits anything before its result — pipe through
`sed -n 's/^data: //p;/^{/p'` to handle both, since a plain `s/^data: //p` prints nothing
at all for the ordinary JSON case and looks like a failed call.

`test/mcp.test.ts` builds exactly these requests, so it is the executable version of this
page.

## Troubleshooting

See the table in the [README](../README.md#troubleshooting) — it is the only one, so it
stays correct.

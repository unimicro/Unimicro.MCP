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

Transport **Streamable HTTP**, URL `http://localhost:3000/mcp`, then Connect. Sign in
when the browser opens, then call `check_api_access` — it reports which companies your
account can reach, which confirms the whole chain works.

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

Useful when a client is misbehaving and you want to see the wire. The 2026-07-28 revision
is strict: routing headers on the outside, a `_meta` envelope on the inside.

```bash
curl -sN -X POST http://localhost:3000/mcp \
  -H 'Authorization: Bearer <token>' \
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
  -H 'Authorization: Bearer <token>' \
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

Responses may come back as a single JSON body or as one SSE frame; pipe through
`sed -n 's/^data: //p'` when you see `data:` prefixes.

`test/mcp.test.ts` builds exactly these requests, so it is the executable version of this
page.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401` from `/mcp` | Expected without a token. Sign in through your client. |
| Sign-in ends on a Unimicro error page | The redirect URI registered upstream is not exactly `<PUBLIC_URL>/oauth/callback`. |
| `Parse error: Invalid JSON` | The `_meta` envelope is missing, or `Content-Type` is not `application/json`. |
| `Unknown client_id` on `/oauth/authorize` | The client registered before a restart. In-memory registrations do not survive one — reconnect. |
| Tools error with a list of companies | Working as intended: pass one as `companyKey`. |
| `403` on `/mcp` from a browser client | Its origin is not allowed. Add it to `ALLOWED_ORIGINS`. |
| Server refuses to start, "must use https" | `PUBLIC_URL` is plain HTTP and not localhost. |

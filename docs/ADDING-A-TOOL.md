# Adding a tool

Getting a tool to *work* takes five minutes. Getting one the model uses *correctly* is
the actual craft, and most of this page is about that.

Start by copying `src/tools/check-access.ts` — it is the reference shape.

## The mechanics

1. Write `register<Name>Tools(server, ctx)` in a new file under `src/tools/`.
2. Add one line to `src/tools/index.ts`.

There is no reflection and no registry to keep in sync — that one line *is* the registry.

```ts
export function registerTools(server: McpServer, ctx: ToolContext): void {
    registerCheckAccessTool(server, ctx);
    registerInvoiceTools(server, ctx);   // ← yours
}
```

## The shape

```ts
server.registerTool(
    'find_invoices',                       // lower_snake_case, unique, stable
    {
        title: 'Find invoices',            // shown to humans
        description: '…',                  // read by the model — see below
        inputSchema: z.object({ … }),      // zod v4
        outputSchema: z.object({ … }),     // optional, but do it anyway
        annotations: { readOnlyHint: true },
    },
    async (args, mcp) => ({
        content: [{ type: 'text', text: 'a short human-readable summary' }],
        structuredContent: { … },          // must match outputSchema
    }),
);
```

Return **both**. The text block is what a model reads when a client does not understand
structured output; `structuredContent` is what everything else uses. Keep the text
short — it is tokens on every single call.

## Writing a description the model follows

The description is the only thing standing between your tool and being called at the
wrong moment with the wrong arguments. Say what it does, when *not* to reach for it, and
what the limits are:

```ts
description:
    'Verify that this server can reach the Unimicro API as the signed-in user. ' +
    'Returns the API it called, the companies the user can act on, and which company other tools will default to. ' +
    'Use it to confirm setup after connecting, or to diagnose why another tool is failing — not before every call.',
```

That last clause matters more than it looks. Without an explicit "not before every call",
models call diagnostic and listing tools constantly.

Rules that pay for themselves:

- **Describe every parameter** with `.describe()`. A parameter with no description is a
  parameter the model will guess at.
- **Constrain in the schema, not in prose.** `z.string().regex(/^\d{9}$/)` is enforced
  before your code runs; "must be 9 digits" in the description is a suggestion.
- **Prefer search over list.** `find_customers(name)` beats `list_all_customers()` — it
  keeps results small and the model's context clean.
- **Name tools for what they act on**: `find_invoices`, `create_invoice`. Shared prefixes
  help the model tell neighbouring tools apart.

## Annotations

Hints about behaviour. Clients use them to decide what to confirm and what to cache.

| Annotation | Meaning |
|---|---|
| `readOnlyHint` | Modifies nothing |
| `destructiveHint` | May remove or overwrite data (only meaningful when not read-only) |
| `idempotentHint` | Calling twice with the same arguments equals calling once |
| `openWorldHint` | Talks to something outside this server — true for anything hitting the Unimicro API |

## Resolving the company

Almost every Unimicro call needs to know which company it is about. Never take a raw
company key from the model and pass it straight on — go through the context:

```ts
const company = await ctx.resolveCompanyKey(companyKey);
```

That checks, in order: the tool's `companyKey` argument, the `CompanyKey` HTTP header a
host may have set, and finally — if the user has exactly one company — that one. When it
genuinely cannot decide it throws a message listing the options, which the model reads
and acts on.

So give every tool an optional `companyKey` argument, and tell the model to omit it
unless it has been told the choice is ambiguous.

## Calling the API

`ctx.api` carries the caller's token already:

```ts
await ctx.api.get<Row[]>('api/biz/invoices', {
    companyKey: company,
    query: { top: 10, filter: "StatusCode eq 30001", orderby: 'InvoiceDate desc' },
});

await ctx.api.post<Row>('api/biz/invoices', payload, { companyKey: company });
```

`query` values are URL-encoded for you. A non-2xx response throws `UnimicroApiError`
carrying the status and body.

## Writes must ask first

Anything that changes data should get the user's confirmation. That is a **multi
round-trip request**: instead of a result, return an elicitation. The client shows a form
and calls your tool *again* with the same arguments plus the user's answer.

```ts
import { acceptedContent, inputRequired } from '@modelcontextprotocol/server';

async ({ name }, mcp) => {
    const answer = acceptedContent<{ confirm: boolean }>(mcp.mcpReq.inputResponses, 'confirm');

    if (!answer) {
        return inputRequired({
            inputRequests: {
                confirm: inputRequired.elicit({
                    message: `Create customer "${name}"?`,
                    requestedSchema: z.object({ confirm: z.boolean().describe('Create this customer') }),
                }),
            },
        });
    }

    if (!answer.confirm) {
        return { content: [{ type: 'text', text: 'Cancelled.' }], structuredContent: { created: false } };
    }

    // …only now write.
}
```

Because the client re-sends the original arguments, **nothing needs to be remembered
between the two calls**. That is why this template has no session store.

If you build a flow where that is not true — several steps, or a value the client must
not see — mint signed state instead:

```ts
const codec = createRequestStateCodec<MyState>({ key: process.env.STATE_KEY! });  // ≥32 bytes

return inputRequired({
    inputRequests: { … },
    requestState: await codec.mint({ step: 'awaiting-approval', draftId }),
});
```

`requestState` round-trips through the client and comes back as **attacker-controlled
input**. Sign it, verify it on the way back in, and never let unverified state decide
anything about authorization.

Tell the model that confirmation is handled for it, or it will ask the user itself and
then ask again through the form:

> The user is shown a confirmation before anything is saved, so call it as soon as you
> have a name — do not ask for confirmation yourself first.

## Errors

Throw. The SDK turns a thrown error into a tool result with `isError: true`, which the
model sees and can recover from. Write the message *for the model*:

```ts
// Good — the model can act on this.
throw new Error('No customer with number 1234. Call find_customers to look one up by name.');

// Useless.
throw new Error('Request failed');
```

Reserve throwing for real failures. "No results" is a successful call that found
nothing — return an empty result and say so in the text block.

## Checklist

- [ ] `lower_snake_case` name, stable across releases
- [ ] Description says what it does, when *not* to use it, and the limits
- [ ] Every parameter has `.describe()`
- [ ] Constraints live in the zod schema
- [ ] `outputSchema` declared, and `structuredContent` matches it
- [ ] Annotations set, `readOnlyHint` honest
- [ ] Company resolved through `ctx.resolveCompanyKey()`
- [ ] Writes confirm through `inputRequired()`
- [ ] A test in `test/mcp.test.ts`

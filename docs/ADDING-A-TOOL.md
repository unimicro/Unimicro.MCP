# Adding a tool

A tool is a function the model can call. Getting one to *work* takes five minutes;
getting one the model uses *correctly* is the actual craft, and most of this page is
about that.

## The mechanics

1. Write `registerXTools(server, ctx)` in a new file under `src/tools/`.
2. Add one line to `src/tools/index.ts`.

There is no reflection and no registry to keep in sync — that one line is the registry.

```ts
export function registerTools(server: McpServer, ctx: ToolContext): void {
    registerCompanyTools(server, ctx);
    registerCustomerTools(server, ctx);
    registerInvoiceTools(server, ctx);   // ← yours
}
```

## The shape of a tool

```ts
server.registerTool(
    'find_invoices',                       // lower_snake_case, unique, stable
    {
        title: 'Find invoices',            // shown to humans
        description: '…',                  // read by the model — see below
        inputSchema: z.object({ … }),      // zod v4
        outputSchema: z.object({ … }),     // optional but do it anyway
        annotations: { readOnlyHint: true },
    },
    async (args, mcp) => ({
        content: [{ type: 'text', text: 'a human-readable summary' }],
        structuredContent: { … },          // must match outputSchema
    }),
);
```

Return **both** `content` and `structuredContent`. The text block is what a model reads
when a client doesn't understand structured output; `structuredContent` is what
everything else uses. Keep the text short — it is tokens on every call.

## Writing a description the model follows

The description is the only thing standing between your tool and being called at the
wrong moment with the wrong arguments. Say what it does, when *not* to reach for it, and
what the limits are:

```ts
description:
    'Search a company\'s customers by name, organization number, or customer number. ' +
    'Searching by organization number or customer number returns an exact match; a name is matched as a substring. ' +
    'With no search argument, returns the first active customers. Returns at most 50.',
```

Rules that pay for themselves:

- **Describe every parameter.** `.describe()` on each zod field. A parameter with no
  description is a parameter the model will guess at.
- **Constrain in the schema, not in prose.** `z.string().regex(/^\d{9}$/)` is enforced
  before your code runs; "must be 9 digits" in the description is a suggestion.
- **Prefer search over list.** `find_customers(name)` beats `list_all_customers()` — it
  keeps results small and the model's context clean.
- **Name tools for what they act on.** `find_customers`, `create_customer`. Shared
  prefixes help the model tell neighbouring tools apart.
- **Say when not to call.** `list_companies` explicitly tells the model not to call it
  before every other tool. Without that line, models call it constantly.

## Annotations

Hints about behaviour. Clients use them to decide what to confirm and what to cache.

| Annotation | Meaning |
|---|---|
| `readOnlyHint` | The tool does not modify anything |
| `destructiveHint` | It may remove or overwrite data (only meaningful when not read-only) |
| `idempotentHint` | Calling it twice with the same arguments is the same as calling it once |
| `openWorldHint` | It talks to something outside this server — true for anything hitting the Unimicro API |

## Resolving the company

Almost every Unimicro call needs to know which company it is about. Never take a raw
company key from the model and pass it on — go through the context:

```ts
const company = await ctx.resolveCompanyKey(companyKey);
```

That checks, in order: the tool's `companyKey` argument, the `CompanyKey` HTTP header the
host may have set, and finally — if the user has exactly one company — that one. When it
genuinely cannot decide, it throws a message listing the options, which the model reads
and acts on.

So give every tool an optional `companyKey` argument, and tell the model to omit it
unless it has been told the choice is ambiguous.

## Writes must ask first

Anything that changes data should get the user's confirmation. That is a **multi
round-trip request**: instead of a result, return an elicitation. The client shows a
form and calls your tool *again* with the same arguments plus the user's answer.

```ts
async ({ name, companyKey }, mcp) => {
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

    if (!answer.confirm) return { content: [{ type: 'text', text: 'Cancelled.' }], structuredContent: { created: false } };

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

Tell the model in the description that confirmation is handled for it, or it will ask
the user itself and then ask again through the form:

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

Reserve throwing for real failures. "No results" is a successful call that found nothing —
return an empty result and say so in the text block.

## Checklist

- [ ] `lower_snake_case` name, stable across releases
- [ ] Description says what it does, when not to use it, and the limits
- [ ] Every parameter has `.describe()`
- [ ] Constraints live in the zod schema
- [ ] `outputSchema` declared, and `structuredContent` matches it
- [ ] Annotations set, `readOnlyHint` honest
- [ ] Company resolved through `ctx.resolveCompanyKey()`
- [ ] Writes confirm through `inputRequired()`
- [ ] A test in `test/mcp.test.ts`

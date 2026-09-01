import { z } from 'zod';
import { acceptedContent, inputRequired, type McpServer } from '@modelcontextprotocol/server';
import { odata } from '../unimicro/api.js';
import type { ToolContext } from './context.js';

/**
 * Two tools over the same resource: one that reads, one that writes.
 *
 * `find_customers` shows the ordinary shape — zod in, zod out, an OData query.
 * `create_customer` shows the shape every write should take: ask the user
 * first, using a multi round-trip request.
 */

const customerShape = z.object({
    id: z.number(),
    name: z.string(),
    customerNumber: z.number().optional(),
    organizationNumber: z.string().optional(),
});

interface CustomerRow {
    ID?: number;
    CustomerNumber?: number;
    OrgNumber?: string;
    Info?: { Name?: string };
}

export function registerCustomerTools(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        'find_customers',
        {
            title: 'Find customers',
            description:
                'Search a company\'s customers by name, organization number, or customer number. ' +
                'Searching by organization number or customer number returns an exact match; a name is matched as a substring. ' +
                'With no search argument, returns the first active customers. Returns at most 50.',
            inputSchema: z.object({
                name: z.string().min(1).optional().describe('Part of the customer name, matched case-insensitively.'),
                organizationNumber: z.string().regex(/^\d{9}$/).optional().describe('Norwegian organization number, exactly 9 digits.'),
                customerNumber: z.number().int().positive().optional().describe('The customer number as shown in Unimicro.'),
                limit: z.number().int().min(1).max(50).default(10).describe('Maximum rows to return.'),
                companyKey: z.string().uuid().optional().describe('Which company to search. Omit unless a tool has told you the company is ambiguous.'),
            }),
            outputSchema: z.object({
                count: z.number(),
                customers: z.array(customerShape),
            }),
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async ({ name, organizationNumber, customerNumber, limit, companyKey }) => {
            const company = await ctx.resolveCompanyKey(companyKey);

            // Most specific filter wins; 30001 is Unimicro's "active" status code.
            const filter = organizationNumber ? odata.eq('OrgNumber', organizationNumber)
                : customerNumber !== undefined ? odata.eq('CustomerNumber', customerNumber)
                : name ? odata.contains('Info.Name', name)
                : 'StatusCode eq 30001';

            const rows = await ctx.api.get<CustomerRow[]>('api/biz/customers', {
                companyKey: company,
                query: { filter, expand: 'Info', top: limit },
            });

            const customers = (rows ?? []).flatMap(row => row.ID === undefined ? [] : [{
                id: row.ID,
                name: row.Info?.Name ?? 'Unnamed customer',
                ...(row.CustomerNumber !== undefined ? { customerNumber: row.CustomerNumber } : {}),
                ...(row.OrgNumber ? { organizationNumber: row.OrgNumber } : {}),
            }]);

            return {
                content: [{
                    type: 'text',
                    text: customers.length === 0
                        ? 'No customers matched.'
                        : customers.map(c => `#${c.customerNumber ?? c.id} ${c.name}${c.organizationNumber ? ` (${c.organizationNumber})` : ''}`).join('\n'),
                }],
                structuredContent: { count: customers.length, customers },
            };
        },
    );

    server.registerTool(
        'create_customer',
        {
            title: 'Create customer',
            description:
                'Create a new customer in a company. This writes to the accounting system. ' +
                'The user is shown a confirmation before anything is saved, so call it as soon as you have a name — ' +
                'do not ask for confirmation yourself first.',
            inputSchema: z.object({
                name: z.string().min(1).describe('Customer name, as it should appear in the ledger.'),
                organizationNumber: z.string().regex(/^\d{9}$/).optional().describe('Norwegian organization number, exactly 9 digits.'),
                companyKey: z.string().uuid().optional().describe('Which company to create the customer in. Omit unless a tool has told you the company is ambiguous.'),
            }),
            outputSchema: z.object({
                created: z.boolean(),
                customer: customerShape.optional(),
            }),
            // A write that is neither idempotent nor reversible from here.
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async ({ name, organizationNumber, companyKey }, mcp) => {
            const company = await ctx.resolveCompanyKey(companyKey);

            // ── Multi round-trip request ────────────────────────────────────
            // On the first call there is no answer yet, so we return an
            // elicitation instead of a result. The client shows the form and
            // calls this same tool again with the same arguments plus the
            // user's answer — which is why nothing needs to be remembered
            // server-side between the two calls.
            const answer = acceptedContent<{ confirm: boolean }>(mcp.mcpReq.inputResponses, 'confirm');

            if (!answer) {
                return inputRequired({
                    inputRequests: {
                        confirm: inputRequired.elicit({
                            message: `Create customer "${name}"${organizationNumber ? ` (org. no. ${organizationNumber})` : ''}?`,
                            requestedSchema: z.object({
                                confirm: z.boolean().describe('Create this customer'),
                            }),
                        }),
                    },
                });
            }

            if (!answer.confirm) {
                return {
                    content: [{ type: 'text', text: 'Cancelled — no customer was created.' }],
                    structuredContent: { created: false },
                };
            }

            const created = await ctx.api.post<CustomerRow>('api/biz/customers', {
                _createguid: crypto.randomUUID(),
                Info: { Name: name },
                ...(organizationNumber ? { OrgNumber: organizationNumber } : {}),
            }, { companyKey: company });

            const customer = {
                id: created.ID ?? 0,
                name: created.Info?.Name ?? name,
                ...(created.CustomerNumber !== undefined ? { customerNumber: created.CustomerNumber } : {}),
                ...(created.OrgNumber ? { organizationNumber: created.OrgNumber } : {}),
            };

            return {
                content: [{ type: 'text', text: `Created customer #${customer.customerNumber ?? customer.id} ${customer.name}.` }],
                structuredContent: { created: true, customer },
            };
        },
    );
}

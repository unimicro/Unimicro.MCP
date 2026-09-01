import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolContext } from './context.js';

const output = z.object({
    companies: z.array(z.object({
        companyKey: z.string().describe('Pass this as the companyKey argument to other tools.'),
        name: z.string(),
        organizationNumber: z.string().optional(),
    })),
});

/**
 * The simplest tool in the template: no arguments, one API call, a typed
 * result. Read this one first.
 */
export function registerCompanyTools(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        'list_companies',
        {
            title: 'List companies',
            description:
                'List the Unimicro companies the signed-in user can act on behalf of, with the companyKey each other tool needs. ' +
                'Call this only when a tool has reported that the company is ambiguous, or when the user asks to switch company — ' +
                'not before every call.',
            inputSchema: z.object({}),
            outputSchema: output,
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async () => {
            const companies = await ctx.api.listCompanies();
            const structuredContent = {
                companies: companies.map(c => ({
                    companyKey: c.key,
                    name: c.name,
                    ...(c.organizationNumber ? { organizationNumber: c.organizationNumber } : {}),
                })),
            };

            return {
                content: [{
                    type: 'text',
                    text: companies.length === 0
                        ? 'This user has access to no companies.'
                        : companies.map(c => `${c.name}${c.organizationNumber ? ` (${c.organizationNumber})` : ''} — ${c.key}`).join('\n'),
                }],
                structuredContent,
            };
        },
    );
}

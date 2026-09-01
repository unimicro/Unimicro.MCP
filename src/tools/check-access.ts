import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolContext } from './context.js';

/**
 * The one tool this template ships.
 *
 * It proves the whole chain works end to end — the client signed in, the
 * broker exchanged a real token, the token validated, and the Unimicro API
 * answered — and it is the shape every other tool will take. Copy it.
 *
 * See docs/ADDING-A-TOOL.md.
 */
export function registerCheckAccessTool(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        'check_api_access',
        {
            title: 'Check Unimicro API access',
            description:
                'Verify that this server can reach the Unimicro API as the signed-in user. ' +
                'Returns the API it called, the companies the user can act on, and which company other tools will default to. ' +
                'Use it to confirm setup after connecting, or to diagnose why another tool is failing — not before every call.',
            inputSchema: z.object({}),
            outputSchema: z.object({
                ok: z.boolean().describe('True when the Unimicro API answered.'),
                apiBaseUrl: z.string().describe('The Unimicro API this server is configured against.'),
                companyCount: z.number(),
                companies: z.array(z.object({
                    companyKey: z.string().describe('Pass this as the companyKey argument to other tools.'),
                    name: z.string(),
                    organizationNumber: z.string().optional(),
                })),
                defaultCompanyKey: z.string().nullable().describe('The company other tools use when none is given, or null when the choice is ambiguous.'),
                notes: z.array(z.string()).describe('Anything worth telling the user about this setup.'),
            }),
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        },
        async () => {
            const companies = await ctx.companies();
            const notes: string[] = [];

            // resolveCompanyKey throws when it genuinely cannot decide. Here that
            // is a diagnostic to report, not a failure — and the companies are
            // already in this result, so the note stays short rather than
            // repeating the whole list a second time.
            let defaultCompanyKey: string | null = null;
            try {
                defaultCompanyKey = await ctx.resolveCompanyKey();
            } catch {
                notes.push(companies.length === 0
                    ? 'This user has access to no companies. Check that the account is active and licensed.'
                    : 'No default company: pass one of the companyKey values above to other tools.');
            }

            if (ctx.headerCompanyKey) {
                notes.push(`The host sent a CompanyKey header (${ctx.headerCompanyKey}), so tools will use that company.`);
            }

            const structuredContent = {
                ok: true,
                apiBaseUrl: ctx.apiBaseUrl.origin,
                companyCount: companies.length,
                companies: companies.map(c => ({
                    companyKey: c.key,
                    name: c.name,
                    ...(c.organizationNumber ? { organizationNumber: c.organizationNumber } : {}),
                })),
                defaultCompanyKey,
                notes,
            };

            const lines = [
                `Connected to ${ctx.apiBaseUrl.origin}.`,
                companies.length === 0
                    ? 'This user has access to no companies.'
                    : `${companies.length} ${companies.length === 1 ? 'company' : 'companies'}:`,
                ...companies.map(c => `  ${c.name}${c.organizationNumber ? ` (${c.organizationNumber})` : ''} — ${c.key}`),
                ...notes,
            ];

            return {
                content: [{ type: 'text', text: lines.join('\n') }],
                structuredContent,
            };
        },
    );
}

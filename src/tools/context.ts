import type { Company, UnimicroApi } from '../unimicro/api.js';

/**
 * What every tool is handed: an API client already carrying the caller's
 * token, and a way to work out which company to act on.
 */
export interface ToolContext {
    api: UnimicroApi;
    /**
     * `CompanyKey` from the HTTP request, when the host application sets one.
     * Hosts that already know which company the user is looking at send it, so
     * tools should not ask.
     */
    headerCompanyKey: string | undefined;
    /**
     * Decide which company a call is about, in order: the tool's own
     * `companyKey` argument, then the request header, then — if the user has
     * exactly one company — that one.
     *
     * Throws a message written for the model to read and act on, because a
     * tool error is the only channel back to it.
     */
    resolveCompanyKey(explicit?: string): Promise<string>;
}

export function createToolContext(api: UnimicroApi, headerCompanyKey: string | undefined): ToolContext {
    let cached: Company[] | undefined;

    const companies = async (): Promise<Company[]> => (cached ??= await api.listCompanies());

    return {
        api,
        headerCompanyKey,
        async resolveCompanyKey(explicit?: string): Promise<string> {
            if (explicit) return explicit;
            if (headerCompanyKey) return headerCompanyKey;

            const available = await companies();
            if (available.length === 1 && available[0]) return available[0].key;
            if (available.length === 0) {
                throw new Error('This user has access to no Unimicro companies. Check that the account is active and licensed.');
            }

            const options = available.map(c => `  ${c.name}${c.organizationNumber ? ` (${c.organizationNumber})` : ''} — companyKey: ${c.key}`).join('\n');
            throw new Error(`This user has access to several companies. Re-run the tool with a companyKey argument:\n${options}`);
        },
    };
}

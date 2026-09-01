/**
 * A thin, typed wrapper over the Unimicro REST API.
 *
 * Two things make a Unimicro call work: the caller's bearer token, and a
 * `CompanyKey` header naming which company to act on. Everything else is
 * ordinary REST with OData-style query parameters.
 *
 * There is deliberately no database here. Which companies a user may act on is
 * a question Unimicro already answers — `GET /api/init/companies` — so asking
 * it directly is both simpler and always current.
 */

export interface Company {
    key: string;
    name: string;
    organizationNumber: string | undefined;
}

export class UnimicroApiError extends Error {
    constructor(
        readonly status: number,
        readonly path: string,
        readonly body: string,
    ) {
        super(`Unimicro API returned ${status} for ${path}${body ? `: ${truncate(body, 400)}` : ''}`);
        this.name = 'UnimicroApiError';
    }
}

export class UnimicroApi {
    readonly #token: string;
    readonly #baseUrl: URL;

    constructor(token: string, baseUrl: URL) {
        this.#token = token;
        this.#baseUrl = baseUrl;
    }

    /** The companies this token's user may act on behalf of. */
    async listCompanies(signal?: AbortSignal): Promise<Company[]> {
        const rows = await this.request<RawCompany[]>('GET', '/api/init/companies', { signal });
        return (rows ?? []).map(row => ({
            key: row.Key ?? row.CompanyKey ?? '',
            name: row.Name ?? row.CompanyName ?? 'Unnamed company',
            organizationNumber: row.OrganizationNumber ?? undefined,
        })).filter(company => company.key !== '');
    }

    get<T>(path: string, options: RequestOptions = {}): Promise<T> {
        return this.request<T>('GET', path, options);
    }

    post<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
        return this.request<T>('POST', path, { ...options, body });
    }

    async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
        const url = new URL(path.replace(/^\//, ''), this.#baseUrl);
        if (options.query) {
            for (const [key, value] of Object.entries(options.query)) {
                if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
            }
        }

        const headers: Record<string, string> = {
            authorization: `Bearer ${this.#token}`,
            accept: 'application/json',
        };
        if (options.companyKey) headers['CompanyKey'] = options.companyKey;
        if (options.body !== undefined) headers['content-type'] = 'application/json';

        const response = await fetch(url, {
            method,
            headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: options.signal ?? AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
            throw new UnimicroApiError(response.status, url.pathname, await response.text().catch(() => ''));
        }
        if (response.status === 204) return undefined as T;

        return (await response.json()) as T;
    }
}

export interface RequestOptions {
    companyKey?: string | undefined;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    signal?: AbortSignal | undefined;
}

interface RawCompany {
    Key?: string;
    CompanyKey?: string;
    Name?: string;
    CompanyName?: string;
    OrganizationNumber?: string;
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max)}…`;
}

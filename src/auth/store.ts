/**
 * A Map whose entries expire.
 *
 * The broker needs to remember two things for a few minutes: an in-flight
 * login, and an authorization code it has issued but not yet redeemed. Both
 * are short-lived and worthless once used, so an in-process Map is the honest
 * data structure.
 *
 * It also means restarting the server drops in-flight logins, and running two
 * replicas behind a load balancer breaks them. That is fine for local
 * development and a single container. For anything else, swap this for Redis —
 * `TtlStore` is the only interface you need to reimplement.
 */
export class TtlStore<V> {
    readonly #entries = new Map<string, { value: V; expiresAt: number }>();
    readonly #ttlMs: number;

    constructor(ttlMs: number) {
        this.#ttlMs = ttlMs;
    }

    set(key: string, value: V): void {
        this.#sweep();
        this.#entries.set(key, { value, expiresAt: Date.now() + this.#ttlMs });
    }

    get(key: string): V | undefined {
        const entry = this.#entries.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= Date.now()) {
            this.#entries.delete(key);
            return undefined;
        }
        return entry.value;
    }

    /**
     * Read and delete in one step. Authorization codes and login transactions
     * are single-use; taking them atomically is what makes replay impossible.
     */
    take(key: string): V | undefined {
        const value = this.get(key);
        if (value !== undefined) this.#entries.delete(key);
        return value;
    }

    get size(): number {
        this.#sweep();
        return this.#entries.size;
    }

    #sweep(): void {
        const now = Date.now();
        for (const [key, entry] of this.#entries) {
            if (entry.expiresAt <= now) this.#entries.delete(key);
        }
    }
}

/** Caches promise results for a fixed time. Failed loads are not cached. */
export class TtlCache {
  private readonly entries = new Map<string, { expires: number; value: Promise<unknown> }>();

  constructor(private readonly ttlMs: number) {}

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && existing.expires > now) {
      return existing.value as Promise<T>;
    }
    const value = load();
    this.entries.set(key, { expires: now + this.ttlMs, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) {
        this.entries.delete(key);
      }
    });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}

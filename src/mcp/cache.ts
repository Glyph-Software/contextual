/** Process-local LRU with an absolute lifetime and explicit memory accounting. */
export class BoundedCache<T> {
  private entries = new Map<string, { value: T; bytes: number; expires: number }>();
  private bytes = 0;
  constructor(private maxEntries = 128, private maxBytes = 8 * 1024 * 1024, private ttlMs = 300_000, private now = Date.now) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.remove(key);
    if (entry.expires <= this.now()) return undefined;
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    return entry.value;
  }

  set(key: string, value: T, bytes: number): boolean {
    this.remove(key);
    if (bytes > this.maxBytes) return false;
    for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.remove(id);
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.remove(this.entries.keys().next().value!);
    this.entries.set(key, { value, bytes, expires: this.now() + this.ttlMs });
    this.bytes += bytes;
    return true;
  }

  private remove(key: string): void {
    this.bytes -= this.entries.get(key)?.bytes ?? 0;
    this.entries.delete(key);
  }
}

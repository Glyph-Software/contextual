import { db } from '../db';
import { envNumber } from '../config';

export interface Version { revision: string; updatedAt: string }
/** One version row; the DB clock and triggers also cover out-of-process writes. */
export async function readVersion(): Promise<Version> {
  const rows = await db()`SELECT value AS revision, updated_at::text AS "updatedAt" FROM settings WHERE key = 'corpus_version'` as unknown as Version[];
  return rows[0] ?? { revision: '0', updatedAt: '' };
}

export function watchForChanges(onChange: (uris: string[]) => void | Promise<void>, intervalMs = envNumber('CONTEXTUAL_WATCH_MS')): () => void {
  let stopped = false, running = false, pending = false;
  let last: Version | null = null;
  let subscription: { unlisten(): Promise<unknown> } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryMs = intervalMs;
  const retry = (fn: () => void) => {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = undefined; fn(); }, retryMs);
    timer.unref?.();
    retryMs = Math.min(30000, retryMs * 2);
  };
  const tick = async () => {
    if (stopped) return;
    if (running) { pending = true; return; }
    running = true;
    try {
      const now = await readVersion();
      if (last && last.revision !== now.revision) {
        const since = last.updatedAt || '1970-01-01T00:00:00Z';
        let cursor = '', notified = false;
        while (!stopped) {
          const rows = await db()`SELECT n.uri FROM nodes n JOIN sources s ON s.id = n.source_id
            WHERE (n.updated_at > ${since}::timestamptz OR s.updated_at > ${since}::timestamptz)
              AND n.uri > ${cursor} ORDER BY n.uri LIMIT 500` as unknown as { uri: string }[];
          if (!rows.length) break;
          await onChange(rows.map((r) => r.uri));
          notified = true;
          cursor = rows.at(-1)!.uri;
          if (rows.length < 500) break;
        }
        // Deletions still invalidate the catalog even though their nodes are gone.
        if (!notified) await onChange([]);
      }
      last = now;
      retryMs = intervalMs;
    } catch { retry(() => { void tick(); }); }
    finally {
      running = false;
      if (pending) { pending = false; void tick(); }
    }
  };
  const start = async () => {
    try {
      await tick();
      if (stopped) return;
      const sql = db();
      // Bun 1.4 owns a dedicated reconnecting listener. Reconnect callbacks
      // re-read the durable version to catch notifications missed offline.
      const listen = (sql as any).listen;
      if (typeof listen !== 'function') {
        // Compatibility for older Bun; never used by the supported runtime.
        const poll = () => { void tick().finally(() => retry(poll)); };
        retry(poll);
        return;
      }
      const [row] = await sql`SELECT current_schema() AS schema`;
      subscription = await listen.call(sql, 'contextual_changed', (schema: string) => {
        if (schema === row.schema) void tick();
      }, () => { void tick(); });
      if (stopped) await subscription?.unlisten();
    } catch { retry(() => { void start(); }); }
  };
  void start();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    void subscription?.unlisten().catch(() => {});
  };
}

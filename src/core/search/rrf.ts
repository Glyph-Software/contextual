/**
 * Reciprocal rank fusion.
 *
 * Fuses ranked lists by position rather than by score, which is what makes it
 * the right tool here: `ts_rank_cd` and cosine distance are on incomparable
 * scales, and any attempt to normalize them into a weighted sum needs
 * per-corpus tuning that a single-tenant local service has no way to do.
 *
 * The constant 60 is the standard damping term from Cormack et al.; it keeps
 * one list's top hit from dominating when the two lists disagree.
 */
export const RRF_K = 60;

export interface Ranked<T> {
  key: string | number;
  item: T;
}

export interface Fused<T> {
  key: string | number;
  item: T;
  score: number;
  /** Which input lists contributed, and at what rank — useful for explaining a hit. */
  ranks: Record<string, number>;
}

export function rrf<T>(lists: Record<string, Ranked<T>[]>, k = RRF_K): Fused<T>[] {
  const acc = new Map<string | number, Fused<T>>();

  for (const [label, list] of Object.entries(lists)) {
    list.forEach((entry, i) => {
      const rank = i + 1;
      const existing = acc.get(entry.key);
      if (existing) {
        existing.score += 1 / (k + rank);
        existing.ranks[label] = rank;
      } else {
        acc.set(entry.key, { key: entry.key, item: entry.item, score: 1 / (k + rank), ranks: { [label]: rank } });
      }
    });
  }

  return [...acc.values()].sort(
    // Ties break toward the item with the better single rank, so ordering is
    // deterministic instead of depending on Map insertion order.
    (a, b) => b.score - a.score || bestRank(a) - bestRank(b) || String(a.key).localeCompare(String(b.key)),
  );
}

const bestRank = <T,>(f: Fused<T>) => Math.min(...Object.values(f.ranks));

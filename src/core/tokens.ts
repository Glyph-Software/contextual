/**
 * Token budgets and the estimator behind them.
 *
 * This lives in `core/` rather than `mcp/format.ts` because the chunker and
 * the catalog need it, and `core/` must stay free of MCP types so a second
 * transport (HTTP, multi-tenant) is additive rather than a rewrite. The MCP
 * layer re-exports both symbols, so nothing outside `core/` has to care.
 */

/**
 * Token budgets, in tokens. The catalog budget is a product contract from the
 * progressive-disclosure design, not a tuning knob: an agent reads L0 on every
 * session, so it stays cheap even with a large corpus.
 */
export const BUDGET = {
  index: 2_000,
  ls: 4_000,
  glob: 2_000,
  grep: 6_000,
  read: 12_000,
  search: 8_000,
  skill: 10_000,
} as const;

/**
 * ~4 chars per token is the usual English approximation. Deliberately cheap:
 * this runs on every tool result, and a real tokenizer would add a dependency
 * and latency to enforce a budget that only needs to be approximately right.
 * It over-estimates on code and tables, which errs toward staying under budget.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

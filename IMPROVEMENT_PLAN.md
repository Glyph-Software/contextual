# contextual — improvement plan

> Written 10 Sep 2026 against the repo as it stands after `PLAN.md` (original
> design) and `REVIEW.md` (second-pass review, 12 findings, mostly fixed).
> This is a **third pass**: a full re-read of all nine subsystems
> (`db`, `ingest/skill`, `ingest/document`, `vfs`, `search`, `catalog`,
> `mcp`, `cli`, `test`) plus external research on Postgres/pgvector
> internals, the Voyage API, Bun 1.4, the Agent Skills spec, chunking
> literature, and the MCP ecosystem as of September 2026. Every finding below
> was checked against the actual source, not just inferred from the README.

## Verdict

The architecture is sound and the last two review passes landed real fixes.
What's still wrong is a consistent shape: **guarantees the README states are
true in the common case but false in the case that matters.** Search
"resists" the classic scale problem but its one SQL statement can never use
its own indexes. Symlinks are "never followed" except on the ingest path
everyone will actually use. Bulk re-indexing "covers `add` and `reindex --all`
alike" except for a folder of many small files. Binaries "become
documents" except when they're not actually documents. The fixes are mostly
small — this is a codebase that is 90% of the way to matching its own
documentation, not one that needs re-architecting.

Two things changed since `REVIEW.md` was written that materially affect this
plan: **Bun 1.4** (2026-08-19) is a from-scratch Rust rewrite of the runtime
that adds `sql.listen()`/`sql.notify()`, and **Voyage's `voyage-4` family**
(Jan 2026) superseded `voyage-3.5` with a shared embedding space across sizes
and native quantization. Both open doors this plan uses.

---

## Priority 0 — correctness and security bugs

These break a stated guarantee or silently corrupt/lose data. Fix before
anything else; most are small.

| # | Bug | Where | Impact |
|---|---|---|---|
| 1 | **`cx_search`'s CTE is materialized, so the HNSW and GIN indexes it was built around are never used.** `scoped` is referenced 3× in `hybrid.ts`; Postgres materializes a WITH query referenced more than once unless marked `NOT MATERIALIZED` ([confirmed](https://www.postgresql.org/docs/17/queries-with.html)). Every search sequentially scans every ready chunk's 4 KB vector. This is the single highest-impact bug in the repo — it means search does not scale past a small corpus at all, which is the whole product. | `src/core/search/hybrid.ts:155,178,189,211` | Search degrades to seq scan; large corpora hit the 10s timeout on ordinary queries |
| 2 | **Unrecognized binaries (images, fonts, archives) are ingested as UTF-8 garbage text, chunked, and embedded.** `detect()` computes `looksLikeText` but the result is discarded; anything anydoc doesn't recognize falls through to `TextDecoder`. | `src/core/ingest/detect.ts:75`, `document.ts:94-98` | Voyage spend on noise, catalog/search pollution, `INSERT` can fail on embedded NUL bytes from UTF-16 files |
| 3 | **Non-atomic blocks are never split.** A blank-line-free `.txt`, a 600-item list, or a CSV table becomes one chunk — probed up to 34,223 tokens. `truncation:true` means Voyage only embeds the first ~32k tokens, so the tail is permanently unreachable by vector search. | `src/core/ingest/chunk.ts:95-119` | Whole documents (large lists/tables/unstructured text) are unsearchable past their first ~30k tokens |
| 4 | **`nodes.ts` is an unused generated tsvector that fails ingest above Postgres's 1 MB tsvector limit.** No query reads it — search uses `chunks.ts`, grep uses the trigram index on `nodes.content`. A multi-MB manual or reference file aborts its whole transaction with a raw Postgres error. | `db/migrations/001_init.sql:41-46` | Large documents fail to ingest with an opaque error; the column is pure write cost otherwise |
| 5 | **`cx_grep`'s 200-file cap is applied before the `path_glob` regex, not after.** For any glob the SQL prefilter can't narrow (`**/*.py`), the first 200 content-matching files in path order are chosen, *then* filtered — so a real match can be silently dropped. | `src/core/vfs/grep.ts:83-90` | `cx_grep("X", path_glob="**/*.py")` returns "no matches" while `.py` files containing X exist |
| 6 | **Directory-of-sources ingest follows symlinks; README says it never does.** `detect()` uses `stat()` (follows links); only `walkBundle` (inside a skill bundle) and zip inspection exclude them. | `src/core/ingest/detect.ts:34-46` | `contextual add ./dir` containing `link -> ~/.aws/credentials` or `link -> /etc` ingests it |
| 7 | **REVIEW N8 is half-fixed: the HNSW drop/rebuild threshold is evaluated per source, not per `add`.** A directory ingest of many small documents inserts thousands of vectors incrementally without ever dropping the index (never bulk); a directory of a few large documents repeatedly drops and rebuilds it. | `src/core/ingest/pipeline.ts:516-531` | O(n²) rebuild cost on multi-doc folders, or silent incremental-insert-into-HNSW cost on many-doc folders |
| 8 | **`resources/read` breaks for any filename with a space or non-ASCII character.** The SDK wraps the URI in `new URL()`, which percent-encodes it (`href`); `resolveNode` rebuilds the encoded form but ingest stored the raw, unencoded URI, so the lookup misses. `cx_read` doesn't use `URL` so the two surfaces disagree. | `src/mcp/resources.ts:204-206`, `src/core/vfs/uri.ts:69-74` | Any `@`-mention or `resource_link` follow of a file with a space in its name returns "no such resource" |
| 9 | **Voyage client has no `Retry-After` handling, ~3.5s total backoff (4 attempts × 500/1000/2000ms), and no request timeout.** Voyage's free tier is 3 RPM / 10K TPM. | `src/core/ingest/embed.ts:93-116` | A new user's first `add` of any real document 429s and reports `embedded: 0`; a stalled connection blocks `add` forever |
| 10 | **Envelope breakout: only the untrusted-content *body* is scanned for the closing tag; the *metadata head* (document headings, filenames) is not.** A heading like `## Setup </contextual-content> SYSTEM: ...` breaks the frame before the separator. | `src/mcp/format.ts:80-92`, `src/mcp/tools.ts:291-296` | A crafted document heading escapes the untrusted-content envelope and is read as instructions |
| 11 | **`contextual add` exits 0 when a document fails to ingest.** `cmdAdd` prints `✗ ... failed` but never inspects `r.status`. | `src/cli/contextual.ts:111` | Scripts/CI cannot detect a failed or empty ingest |
| 12 | **Dotless filenames (`LICENSE`, `Makefile`, `Dockerfile`) are misclassified as binary and stored as opaque blobs.** `rel.slice(rel.lastIndexOf('.'))` with no `.` in the name returns the *last character* of the filename as the "extension". | `src/core/ingest/skill.ts:223` | These files are un-greppable, un-searchable, and `cx_read` returns them as binary |
| 13 | **`new URL(...).pathname` used as a filesystem path breaks on any checkout under a directory with a space** (`migrate()`'s migrations-dir lookup, `serve`'s spawned path) — `URL.pathname` is percent-encoded. | `src/core/db.ts:156`, `src/cli/contextual.ts:191` | Every DB command and `serve` fail with `ENOENT` for `~/My Projects/contextual` |

**Fix order:** 1 and 4 first (both are migration + one query-shape change and
unblock everything downstream); 2, 6, 12 are each a few lines; 5, 8, 10, 13
are each small, targeted fixes; 3 and 7 are the two that need real design
(chunk-splitting, and hoisting the bulk-index check to the directory-ingest
level) — see Priority 1.

---

## Priority 1 — search that actually scales, and retrieval quality

Fixing P0-1 (materialized CTE) is necessary but not sufficient — research
confirmed a second, related problem, and there's a cluster of retrieval-
quality work that pays for itself once candidate generation is correct.

- **Restructure the hybrid-search SQL.** Mark `scoped` `NOT MATERIALIZED` (or
  give each retriever its own base-table join so the planner can push the
  scope/status filter into the index scan), then `SET LOCAL hnsw.ef_search =
  max(100, 4*k)` and `hnsw.iterative_scan = relaxed_order` inside the
  existing `withStatementTimeout` transaction — pgvector 0.8.0+ (confirmed
  shipped in `pgvector/pgvector:pg17`, currently 0.8.6) needs this because a
  `WHERE` scope filter applied *after* an HNSW index scan otherwise starves
  `LIMIT k` down to a couple of surviving rows exactly when an agent scoped
  the search. **Add an `EXPLAIN`-asserting test that names both indexes** —
  this whole class of regression has now shipped twice with no test able to
  see it.
- **Guarantee per-query representation in multi-query fusion.** Today all
  `fts:i`/`vec:i` lists are fused into one ranking and sliced to `limit`; a
  chunk that weakly matches 5 of 8 sub-questions can crowd out the only
  chunk that answers one of them — the opposite of what the tool description
  promises. Reserve top-`ceil(limit/queries)` per query via round-robin fill
  before backfilling with the raw RRF order. Small, high-impact.
- **Dedupe overlapping chunks and cap hits per document.** Chunks overlap by
  ~100 tokens by design, so an answer straddling a chunk boundary can appear
  twice in an 8-result page.
- **Split oversize non-atomic blocks** (paragraph by sentence, list by item,
  huge tables/CSV by row-batches with the header re-emitted) instead of
  emitting one 34k-token chunk. This is the real fix for P0-3.
- **Add contextual chunk prefixing**: prepend the document/collection name
  and full `heading_path` (not just the leaf) to the text that gets embedded
  and FTS-indexed, in a way that doesn't leak into what `cx_read` shows a
  human. This is a deterministic, free version of what Anthropic's
  [Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)
  post measured: 35–49% fewer top-20 retrieval failures from adding this
  context alone; a rerank stage on top took it to 67%. The data
  (`heading_path`) is already computed and simply never indexed today.
- **Add an optional rerank stage** over the fused top ~30 via Voyage's
  reranker. Confirmed GA and cheap: `rerank-2.5-lite` is $0.02/1M tokens
  with 200M free, 32K context, 1000 docs/request. Gate it behind having an
  API key, same as embeddings.
- **Evaluate `voyage-context-4`** (shipped June 2026,
  `POST /v1/contextualizedembeddings`) as an alternative or complement to
  the deterministic heading-path prefix — it's purpose-built for exactly
  this "chunk lost its document context" problem and shares Voyage's
  existing auth/billing path. Worth a benchmark against the prefix approach
  before committing to one.
- **Move to the `voyage-4` family.** `voyage-3.5` is no longer current;
  `voyage-4`/`voyage-4-lite`/`voyage-4-large` (Jan 2026) share one embedding
  space, so a size change needs no re-index, and they support native
  `int8`/`binary` quantization — worth evaluating against `halfvec` for
  shrinking the HNSW index. The corpus's `embed_model` pin makes this a safe
  `reindex --all` switch whenever it happens.
- **Hoist the bulk-index check to the directory-ingest level** (fixes P0-7
  properly): accumulate pending-vector counts across every source written
  during one `contextual add ./folder` and make one drop/rebuild decision,
  not one per source.

---

## Priority 2 — protocol and runtime currency

Two external facts changed the ground this project stands on:

- **A real MCP TypeScript SDK v2 now exists** (`@modelcontextprotocol/server`,
  distinct package from `@modelcontextprotocol/sdk`), implementing the actual
  2026-07-28 revision — stateless core, `server/discover`, `resultType`,
  `ttlMs`/`cacheScope`, and `subscriptions/listen` replacing
  `resources/subscribe`. It runs on Bun. This retires the current
  `modernClient`/`observeClient` heuristic in `resources.ts`, which was built
  on a **wrong reading of the spec** — 2026-07-28 *removes* the `initialize`
  handshake the heuristic depends on, so it can never fire for a real
  conforming client (confirmed by `review-findings-audit`, independently
  confirmed by research). Migration is largely mechanical
  (`registerTool`/`registerResource` unchanged, `McpError` → `ProtocolError`,
  an official codemod exists) but is genuinely a project (worktree spike
  first — confirm Bun compatibility, since the wrapped `@firecrawl/anydoc`
  native addon is the one dependency most likely to be affected by any
  runtime change).
- **Bun 1.4** (2026-08-19) is a ground-up Rust rewrite, not an incremental
  release — treat the 1.3.11 → 1.4.2 upgrade as major-version-equivalent, not
  a patch bump. It brings real wins this project can use directly:
  - `sql.listen()`/`sql.notify()`, on a dedicated auto-reconnecting
    connection with exponential backoff — replaces `catalog/watch.ts`'s
    3-second polling of `count(nodes)`/`count(sources)`/`max(updated_at)`,
    which today runs unconditionally per open MCP session and is pure
    Postgres CPU baseline on an idle corpus. Keep the DB-clock read as a
    fallback (still the only way to see writes from another process
    reliably) but stop polling on a timer.
  - The historical `pgArray`-workaround bug (bare JS array binding
    double-quoting) was fixed upstream; worth a real round-trip test on
    1.4.2 before deciding whether `pgArray` can simplify to `sql.array()`.
  - Caveats to test explicitly before upgrading: native-addon loading under
    the rewritten runtime (`@firecrawl/anydoc`), and `Bun.sql` pool
    dead-connection recovery, which has open upstream issues
    (`onclose` not reliably evicting/recreating connections after a
    server-side close) — don't assume the pool is fully self-healing yet;
    keep retry logic at the call site regardless of version.
- **`bun build --compile`** is viable for a single-binary release
  (`--asset` embeds `db/migrations`, resolved via `import.meta.dir`) but
  needs `db.ts`'s `URL.pathname` migrations lookup and `serve`'s spawn-a-.ts-
  path fixed first (both are P0-13 anyway), and should be spiked separately
  given the native-addon risk.

---

## Priority 3 — protocol/product polish (from the full audit)

Grouped by area; each is small on its own. Full detail with exact
`file:line` references and reproduction steps is in the sub-reports at
`/tmp/contextual-plan/understand/*.json` (this session's raw findings) —
worth committing the cleaned-up versions as follow-on `REVIEW-2.md` material
if that pattern continues.

**MCP surface**
- Resource-not-found returns `-32603` (InternalError); spec says `-32002`
  (2025-11-25) / `-32602` (2026-07-28, once migrated).
- No tool `annotations` (`readOnlyHint`/`idempotentHint`/`openWorldHint`) on
  any of the six tools — one line each; Claude Code uses `readOnlyHint`
  today to decide whether tool calls can run in parallel, so this is a
  concrete latency win, not just UX.
- `image` content blocks are emitted for MIME types the Claude API rejects
  (`image/svg+xml`, `image/tiff`, `image/bmp`); whitelist
  `png|jpeg|gif|webp` and fall back to an embedded-resource block otherwise.
- `cx_read('ctx://index')` is rejected even though `cx_ls` hands out that
  exact link — a dead end on the only surface an agent controls.
- `cx_skill`'s not-found error dumps the *uncapped* full `/skills` listing —
  the one path into context with no budget cap.

**Ingest**
- Rename/twin deletion runs *outside* the write transaction — a failed
  re-ingest after a rename can delete the old source and leave neither old
  nor new. Blob writes inside the transaction also aren't staged, so a
  rollback leaves orphaned or silently-overwritten files.
- Multi-skill zips (e.g. a full `anthropics/skills` download) silently
  ingest one nondeterministically-chosen skill and drop the rest with no
  message; `.skill` files (Anthropic's own packaging format from
  `package_skill.py`) aren't recognized as zips at all and fall through to
  the garbage-text path.
- `allowed-tools` parsing only splits on commas; the spec is space-separated
  and Claude Code accepts comma/space/YAML-list with inner-space entries
  like `Bash(git add *)` — needs a real tokenizer.
- Strict rejection of unknown frontmatter keys breaks real-world Claude Code
  skills, which commonly carry `when_to_use`, `argument-hint`,
  `disable-model-invocation`, `user-invocable`, `model`, `effort`, `context`,
  `paths`, `hooks` (confirmed list from Claude Code's own docs) — none of
  these are in the external Agent Skills spec but all are legitimate for a
  skill authored for Claude Code specifically. A `--lenient` mode or
  warn-and-strip default would make far more real skills ingestable without
  weakening validation for spec-conformance testing.
- HTML→Markdown path has no GFM plugin (bare `TurndownService`), so tables,
  strikethrough, and task lists are silently destroyed. `turndown-plugin-gfm`
  (the original) looks unmaintained; `@joplin/turndown-plugin-gfm` or
  `@truto/turndown-plugin-gfm` are the better-maintained options.

**VFS**
- No canonical URI encoding at the root cause of P0-8; `#`/`?` in filenames
  are storable but unaddressable; a literal `%` not followed by hex digits
  aborts ingest entirely; `cx_ls` can merge sibling directories whose names
  differ only by `_`/`%` (unescaped `LIKE`).
- `cx_ls` loads every node of a source into JS with no pagination — costs
  grow with corpus size even though the render is capped.
- Brace-glob (`{*.md,*.py}`) and character-class (`[abc]`) globs are
  silently matched literally instead of expanded/supported or rejected.

**CLI / ops / packaging**
- Unknown flags crash with a raw `TypeError` stack instead of the friendly
  help+exit-2 path unknown *commands* already get.
- A down database prints exactly `✗ Connection closed` with no mention of
  the URL tried or `docker compose up -d` — the first error most new users
  will hit.
- 16 env vars are read across 9 files with bare `Number(...)`; a typo'd
  value becomes `NaN` and silently disables a feature (vector search,
  bulk-index threshold) or breaks it outright (every `cx_grep` errors). A
  small validated config module would fix this everywhere at once and could
  also generate the CLI help text and README table, which currently
  disagree (help documents 6 vars, README 8, code reads 16).
- `package.json` is `"private": true` with a `.ts` `bin` — unpublishable as
  written; no `LICENSE`, `engines.bun`, CI, or lint config exists.
- `docker-compose.yml` uses a floating `pg17` tag with no `shm_size`
  (Docker's 64 MiB default causes HNSW build failures under parallel query)
  and no restart policy.

**Tests**
- DB-down suites collapse into one unnamed failing test instead of a clean
  skip with a "start Postgres" message — hides ~97 of 225 tests whenever
  Docker isn't running, which is exactly the failure mode a first-time
  contributor hits.
- Cross-file `process.env` mutation for the test-schema URL is
  order-dependent (Bun runs all files in one process; `--seed` reorders
  them) — a malformed `search_path` is a real, reproducible risk, not
  theoretical.
- Zero CLI tests, zero unit tests for the pure glob/grep translation
  functions, one vacuous chunk test (branch never executes), no
  retrieval-quality eval harness despite retrieval being the product.
- No CI at all — nothing runs `typecheck` or the DB-backed suites
  automatically today.

---

## Suggested phasing

1. **Stop the bleeding** — Priority 0, in the order listed. Each is small;
   together they turn several README claims from aspirational into true.
   Add a regression test alongside each fix (none of these are covered
   today, which is *why* they shipped).
2. **Make search scale** — the CTE restructuring + `EXPLAIN` test, HNSW
   tuning, then the retrieval-quality cluster (contextual prefixing, dedup,
   per-query fusion guarantee, rerank). This is the product; it deserves the
   next slice after correctness.
3. **Runtime and protocol currency** — Bun 1.4 upgrade (with the native-addon
   and connection-pool spikes called out above) and the SDK v2 migration
   spike. Independent of each other; can run in parallel or either order.
4. **Everything else in Priority 3**, roughly in the order: ingest
   transaction safety and multi-skill/`.skill` handling (data-loss-adjacent,
   do these earlier within the phase) → MCP protocol polish → VFS
   addressing → CLI/config/packaging → CI and the test-infrastructure fixes
   (worth doing early within this phase since they'll catch regressions in
   everything above it, going forward).

## What's already right — leave alone

Two Postgres extensions in one database for one-round-trip hybrid retrieval;
reciprocal rank fusion over ranks rather than normalized scores; the
skill-vs-document trust split by *content kind* (not tool name); reject-
don't-normalize path traversal; fail-loud OCR with an explicit, privacy-
scoped opt-in; stderr-only logging enforced by a static test;
`core/`/`mcp/` layering enforced by a static test; the embed-model and
FTS-language corpus pins; loopback-only Postgres by default. These are the
decisions that make everything in this plan an incremental fix rather than a
rewrite — nothing here argues for touching them.

## Sources consulted

- Postgres 17 CTE materialization: https://www.postgresql.org/docs/17/queries-with.html
- pgvector README (HNSW, iterative scan since 0.8.0): https://github.com/pgvector/pgvector
- pg_trgm docs: https://www.postgresql.org/docs/current/pgtrgm.html
- ParadeDB pg_search / VectorChord-BM25 hybrid-search writeups: https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual, https://blog.vectorchord.ai/
- Voyage AI docs (rate limits, embeddings, contextualized embeddings, reranker, tokenization): https://docs.voyageai.com/docs/
- Voyage v4 / voyage-context-4 announcements: https://blog.voyageai.com/2026/01/15/voyage-4/, https://blog.voyageai.com/2026/06/29/voyage-context-4/
- Anthropic Contextual Retrieval: https://www.anthropic.com/engineering/contextual-retrieval
- firecrawl/anydoc: https://github.com/firecrawl/anydoc
- turndown-plugin-gfm forks: https://www.npmjs.com/package/@joplin/turndown-plugin-gfm
- MCP 2026-07-28 changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- MCP TypeScript SDK v2: https://ts.sdk.modelcontextprotocol.io/v2/
- Claude Code MCP env-var expansion: https://code.claude.com/docs/en/mcp
- Claude Code skills docs (frontmatter keys): https://code.claude.com/docs/en/skills
- Agent Skills spec: https://github.com/agentskills/agentskills
- Bun 1.4 release notes: https://bun.com/blog/bun-v1.4
- Bun `sql.listen()`/`sql.notify()`: https://bun.com/docs/runtime/sql

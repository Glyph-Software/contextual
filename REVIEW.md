# contextual — second-pass architecture review

> Historical review. Findings describe the implementation at review time;
> see [README.md](README.md) and [USAGE.md](USAGE.md) for current behavior.

Reviewed 3 Sep 2026 against the repo *after* the first review’s 21 findings were implemented. This is not a test-failure report: the suite is doing its job. It is the leftovers and the holes the fixes introduced.

**12 findings:** 4 high · 7 medium · 1 low.

## Verdict

The first review landed. Loopback Postgres, zip guards, the skill-vs-doc envelope, inline binaries, pagination, catalog elision, rename reclaim, blob deletion, `core/`/`mcp/` layering, strict search scope, DB-clock watch, `compatibility`, FTS language pin, and embed-model pin are all real.

What remains is the class of bug the last pass created: a grep that moved into SQL but kept the old path column; a 2026 listener installed after handshake; zip caps that directory bundles never inherited.

## Pass-1 scorecard

| Finding | Status now |
|---|---|
| H1 HNSW-on-insert | Partial — `reindex --all` rebuilds; `add` still incremental |
| H2 grep JS scan / ReDoS | Moved into Postgres; ReDoS claim is still wrong |
| H3 Postgres on 0.0.0.0 | Fixed — `127.0.0.1:55432` |
| H4 zip slip / `add ~` | Zips and directory-of-sources capped; `walkBundle` is not |
| H5 skill vs doc envelope | `cx_skill` bare; grep still unenveloped |
| H6 binary dead end | Fixed — image / embedded-resource inline |
| H7 2026 subscribe era | Logic exists; wired after `connect` |
| H8 embed batch fail-all | Fixed — `truncation` + isolate-by-chunk |
| M1–M9, L1–L4 | Addressed in code/README; L3 replaced by N10 |

## High

### N1 — `cx_grep` `path_glob` matches the wrong path
**Area:** Product · **Where:** `src/core/vfs/grep.ts`

`glob.ts` already decomposes VFS paths because `n.path` is source-relative (`SKILL.md`, not `/skills/pdf/SKILL.md`). Grep still does `n.path LIKE sqlLike(path_glob)`. An agent that copies `/skills/pdf/**` from `cx_ls` or `cx_glob` gets zero hits. There is no test for `path_glob`.

### N2 — Postgres regex can still pin the stdio process
**Area:** Scale · **Where:** `src/core/vfs/grep.ts`, `src/core/db.ts`

The in-process JS scan is gone. Postgres AREs are still backtracking NFAs, and no `statement_timeout` is set. A hostile pattern blocks a pool client. README’s claim that a pattern cannot pin the process is false.

### N3 — Directory skill ingest has no size, depth, or secret guard
**Area:** Security · **Where:** `src/core/ingest/skill.ts` (`walkBundle`)

Zips are capped (2000 entries, 256 MiB, no symlinks). `walkBundle` is not. A `SKILL.md` at a repo root ingests the tree, including `.env` (dotfiles are skipped for directory-of-sources, not inside a bundle). `contextual add .` is still a footgun.

### N4 — 2026 protocol detection is installed after `connect`
**Area:** Protocol · **Where:** `src/mcp/server.ts`, `src/mcp/resources.ts` (`observeClient`)

`observeClient` wraps `transport.onmessage` *after* `await server.connect(transport)`. `initialize` is the first message and is often consumed during `connect`. `modernClient` then stays false and 2026-07-28 hosts miss every `resources/updated`. The new test can pass or fail depending on spawn timing. Wrap before `connect`, or read the negotiated version from the SDK after handshake.

## Medium

### N5 — Grep hits are not enveloped
**Area:** Product · **Where:** `src/mcp/tools.ts` (`cx_grep`)

README and the H5 fix say documents, search hits, and grep hits are framed as data. `cx_search` and `cx_read` call `envelope()`; `cx_grep` returns raw matching lines.

### N6 — `cx_read` of `SKILL.md` still says do not follow it
**Area:** Product · **Where:** `src/mcp/tools.ts` (`cx_read`)

`cx_skill` returns instructions bare. The same bytes via `ctx://skills/{name}/SKILL.md` are wrapped in the untrusted envelope. Agents follow `resource_link`s with `cx_read`. The split is by tool name, not by content kind.

### N7 — Failed and OCR sources count as real docs in L0
**Area:** Product · **Where:** `src/core/catalog/index.ts` (`loadCatalog`)

Collections use `count(*)` for docs. A collection of scanned PDFs reads as “3 docs, 0 searchable chunks” in the catalog that is supposed to tell the agent what exists to search.

### N8 — First ingest still updates HNSW one vector at a time
**Area:** Scale · **Where:** `src/core/ingest/pipeline.ts` (`embedPending`)

`reindex --all` drops and rebuilds the partial index. `contextual add` of a folder does not. pgvector’s build-after-load advice still applies to the path everyone will use first.

### N9 — `resources/read` has no blob size cap
**Area:** Scale · **Where:** `src/mcp/resources.ts` (`readResource`)

`cx_read` refuses binaries over 3 MiB. The Resources handler base64-encodes the whole file. A human `@`-mention of a large asset can OOM the stdio process.

### N10 — `.mcp.json` uses bash default expansion
**Area:** Product · **Where:** `.mcp.json`

`args` is `${CONTEXTUAL_DIR:-.}/src/mcp/server.ts`. MCP hosts spawn argv as literals; few expand `:-` defaults. Copying the snippet can start a server whose path is that exact string.

### N11 — `getSetting` swallows every SQL error
**Area:** Protocol · **Where:** `src/core/db.ts` (`getSetting`)

A missing `settings` table and a dead connection both return `null`. `ftsConfig` then falls back to `english`; `assertEmbedModel` may try to re-pin the model. Transient DB failures look like an unconfigured corpus.

## Low

### N12 — `PLAN.md` is now a stale design, not the implemented contract
The PDF path was corrected. Zip caps, the envelope split, loopback bind, pagination, and `002_scale_and_settings` are still absent. Following the plan will unteach the last review’s fixes.

## Suggested order

1. Point grep `path_glob` at the same VFS path `glob.ts` already builds.
2. Wrap `observeClient` before `connect`.
3. Give `walkBundle` the zip caps, and skip dotfiles.
4. Envelope grep; treat `role='skill_md'` as instructions on `cx_read`.
5. Set `statement_timeout` on grep/search.
6. Drop HNSW around bulk `add`, not only `reindex --all`.

## Leave alone

Tools + Resources over one `ctx://` tree, fail-loud OCR, PDF via `toMarkdownBytes`, FTS without an API key, reject-don’t-normalize traversal, stderr-only MCP logging, `pgArray`, and DB-clock watch. Those are why v1 is in good shape.

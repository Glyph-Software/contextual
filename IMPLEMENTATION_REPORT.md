# Improvement plan implementation

Implemented against `IMPROVEMENT_PLAN.md`. Runtime verification uses Bun 1.4.2 and PostgreSQL 17 with pgvector 0.8.6, in disposable schemas. The developer's existing corpus has not been migrated.

## Priority 0

| Finding | Implementation and regression coverage |
|---|---|
| 1 — materialized search scope | `NOT MATERIALIZED` scope; bare distance ordering and candidate limit before window ranking; final joins operate on selected IDs. An EXPLAIN test runs the actual search statement on 2,500 fixture vectors and names both `chunks_ts_idx` and `chunks_embedding_idx`. |
| 2 — binary text fallback | Strict UTF-8/BOM-marked UTF-16 decoding rejects binaries, invalid encodings, control bytes, and empty documents. Existing ready content survives a failed normalization. |
| 3 — oversize blocks | Sentence/item splitting with a hard bound; tables split by rows and repeat their headers. Tests preserve long-document tails and all list items. Fenced code remains atomic. |
| 4 — file tsvector size limit | Migration 003 removes `nodes.ts`; a multi-megabyte ingest and tail retrieval run against real Postgres. |
| 5 — grep cap placement | Exact VFS glob predicate precedes the file cap. Regression finds a `.py` file after 205 earlier text matches. |
| 6 — symlink traversal | Directory detection uses `lstat` and regular-file/directory entries; linked SKILL.md and directory members are skipped. Explicit symlink inputs fail. |
| 7 — repeated/missing bulk maintenance | One `ingestMany` pass aggregates pending vectors across every source in an add. A multi-file failure regression observes the dropped index and its guaranteed rebuild. |
| 8 — resource URI encoding | URI builders encode segments; parsers decode at the boundary. Migration 004 uses a temporary namespace to handle old/new URI collisions atomically. Both MCP eras read filenames containing spaces, Unicode, `#`, `?`, and `%`. |
| 9 — Voyage retries | Shared timeout, attempt/wait budgets, jitter, and numeric/HTTP-date Retry-After handling. Tests cover rate limits, timeout aborts, and failure classes. |
| 10 — metadata envelope breakout | Metadata angle brackets are escaped before framing; body closing tags are still cut. |
| 11 — successful exit on failed add | Failed, needs-OCR, and empty adds exit 1, including JSON mode; regressions invoke the real CLI. |
| 12 — dotless text assets | `extname` and strict content decoding classify LICENSE/Makefile/Dockerfile as text references. |
| 13 — filesystem URL paths | Default migrations are embedded text imports. Serving runs through an explicit entry function, including compiled builds. Space-containing checkout and standalone working directories are tested. |

## Retrieval quality

- Scoped HNSW uses transaction-local `ef_search` and iterative scanning.
- Multi-query results reserve slots in round-robin order before global backfill, deduplicate similar passages, and cap results at three per document.
- Source/collection names and full heading paths are indexed and embedded separately from readable content.
- Voyage 4 is the default, retaining dimension/model pins and an explicit `reindex --all` model switch.
- Optional Voyage reranking is controlled by `CONTEXTUAL_RERANK=true`; failures retain ordinary fusion.
- `scripts/eval.ts` evaluates an isolated synthetic corpus. Its default offline FTS run achieved recall@5 = 1.0 and MRR = 1.0 across 10 questions. This is smoke coverage, not a production quality claim.
- `bun run eval --voyage` implements comparisons of plain/prefixed Voyage 4, Voyage Context 4, and float/halfvec/int8/binary representations. **Live comparisons were not executed: no Voyage key is configured.** Production storage remains float vectors until representative quality and index-size measurements support a change.

## Runtime and protocol

The repository pins Bun 1.4.2 and uses MCP SDK v2's `serveStdio` factory. Tests cover actual modern envelopes without initialize, discovery, resultType, subscription filtering, and legacy initialization/subscriptions. Database triggers update a durable version and emit NOTIFY on commit; the listener checks the DB clock on reconnect and retries transient failures. Changes are read in pages, including direct SQL updates. There is no idle polling on the supported runtime.

Two plan assumptions required correction after implementation/probing:

1. **Native `sql.array()` still double-quotes strings in the tested Bun 1.4.2 environment.** `pgArray()` is retained and tested. The pool recovered after terminating a reserved backend; this is one recovery regression, not an exhaustive pool fault-injection campaign.
2. **SDK v2's typed `ResourceNotFoundError` emits `-32602` with `data.uri`.** This is the installed SDK's canonical error, including its legacy compatibility surface. Tests assert the typed shape rather than forcing the old numeric code.

A compiled standalone binary successfully ran migrations, parsed a native DOCX, served an MCP read, and exited on stdin EOF while running outside the checkout. The npm package has a Bun launcher, explicit files list, engines, MIT license, and a local pack check; nothing has been published.

Primary API references used during implementation:

- [Bun 1.4 release](https://bun.com/blog/bun-v1.4) and [SQL LISTEN/NOTIFY](https://bun.com/docs/runtime/sql)
- [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/) plus the installed package's public types and stdio implementation
- [Voyage embeddings](https://docs.voyageai.com/docs/embeddings) and [contextualized chunk embeddings](https://docs.voyageai.com/docs/contextualized-chunk-embeddings)
- [pgvector query/index documentation](https://github.com/pgvector/pgvector)

## Additional improvements

Source renames/deletions now share the write transaction. Each replacement stages blobs in a unique directory, removes them on rollback, and deletes old blobs only after commit. Multi-bundle zip and `.skill` inputs ingest every bundle deterministically. Lenient skill metadata is opt-in, permission tokenization respects parentheses, and HTML conversion uses a maintained GFM plugin.

Tools have read-only/idempotent annotations, safe image MIME selection, catalog reads through `cx_read`, and capped skill-not-found output. VFS listing aggregates immediate children in SQL and paginates; glob matching supports braces/classes and occurs before limits; LIKE prefixes escape literal `%` and `_`.

Numeric settings have validated ranges and a shared source for CLI help and generated README rows. CLI errors are friendly and database diagnostics omit credentials. Docker pins pgvector and configures shared memory/restarts. GitHub Actions runs types, lint, real database/MCP tests, config-document consistency, offline evaluation, and standalone build smoke checks. DB suites skip with a clear message when Postgres is unavailable; CI requires the DB. Test schema URLs preserve other URL options and restore process state.

## Applying to an existing installation

Use Bun 1.4.2+, run `bun install`, update the Docker service with `docker compose up -d`, then run `bun run migrate`. Migration 003 clears old vectors after adding context. Full-text retrieval remains usable; run `bun run src/cli/contextual.ts reindex --all` with a Voyage key to regenerate embeddings and switch the pinned model. No existing production data was changed as part of verification.

## Validation results

- Full suite: **270 passed, 0 failed** across 12 files on Bun 1.4.2.
- Final chunk/HTML/timeout checks after the last small changes: **46 passed, 0 failed**.
- Typecheck, Biome lint, frozen-lockfile installation, and generated configuration documentation check pass.
- Database-unavailable run: **119 skipped, 0 failed**, with the start-Postgres message.
- Offline retrieval evaluation: recall@5 **1.0**, MRR **1.0**, 10 synthetic questions.
- Standalone build smoke: embedded migrations, native DOCX conversion, MCP read, and clean EOF shutdown pass.
- npm dry-run packaging includes 38 files and excludes environment files, MCP local configuration, and blob storage. No publication or push was performed.

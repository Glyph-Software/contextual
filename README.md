# contextual

A context service for agents. It ingests documents and [Agent Skill](https://agentskills.io/specification)
bundles, digests them, and republishes them as a single addressable virtual
filesystem that an agent browses lazily — reading only what it needs, when it
needs it.

The design goal is **progressive disclosure**: a cheap always-available catalog
at level 0, targeted reads at level 1, deep bundle files at level 2. Nothing
enters an agent's context unless the agent asked for it.

```
cx_ls("/")            →  every skill and collection, ≤2k tokens
cx_search([...])      →  ranked snippets with citable ctx:// links
cx_read(uri)          →  one file, or one chunk plus its neighbours
```

## Why two surfaces

MCP **Resources are application-driven, not model-driven**. The host application
decides how to incorporate resource context, and in Claude Code resources are
pulled in by a human typing `@server:resource`. **An agent cannot autonomously
list or read Resources.** A Resources-only VFS would be inert for the primary
use case.

So contextual ships two surfaces over one URI namespace:

| Surface | Controlled by | Purpose |
|---|---|---|
| **Tools** (`cx_ls`, `cx_glob`, `cx_grep`, `cx_read`, `cx_search`, `cx_skill`) | the model | Agent autonomy — this is how the VFS actually gets used |
| **Resources** (`resources/list`, `/read`, `/templates/list`, subscriptions) | the host app / human | Stable addressability, `@`-mentions, citability, change notifications |

They are not two systems. Tool results return MCP `resource_link` content blocks
pointing back into the Resources namespace, so a search hit is a *citation* the
agent or the human can follow. Per spec, resource links returned by tools need
not appear in `resources/list` — which is what lets us cite chunk-level URIs
without listing millions of them.

## Quick start

See [USAGE.md](USAGE.md) for the complete setup guide, MCP tool examples,
configuration, and troubleshooting.

Requires **Bun 1.4.2 or later** (pinned in `.bun-version`) and Docker.

```bash
bun install
docker compose up -d          # postgres + pgvector on :55432
bun run migrate

bun run src/cli/contextual.ts add ./path/to/skill-bundle
bun run src/cli/contextual.ts add ./report.pdf --collection handbook
bun run src/cli/contextual.ts list
```

Register it with Claude Code by copying `.mcp.json` into your project and
replacing `/absolute/path/to/contextual` with this checkout's real path. MCP
hosts spawn `args` as literal argv, so shell syntax such as `${VAR:-default}` is
not expanded and would be passed through verbatim. Then ask a question the corpus
answers. The agent should reach it on its own via `cx_ls` → `cx_search` →
`cx_read`, with no `@`-mention.

Semantic search needs an embedding key:

```bash
export VOYAGE_API_KEY=...              # voyage-4, 1024 dims
bun run src/cli/contextual.ts reindex
```

Without one, **everything still works** — retrieval degrades to full-text only,
and skills need no embeddings at all.

The corpus pins the first embedding model that touches it (`settings.embed_model`).
Changing `CONTEXTUAL_EMBED_MODEL` afterwards is refused until `reindex --all`
re-embeds everything, and a query embedded by a different model is skipped rather
than ranked against vectors from another space. Dimensions are fixed at 1024 by
the schema, so a model with different dimensions needs a migration, not an env var.

Full-text search uses one Postgres text-search configuration, chosen for a
**new** database with `CONTEXTUAL_FTS_LANGUAGE` (default `english`). It is baked
into the generated chunk `tsvector` column, so changing it later means a fresh database.

## The namespace

```
ctx://index                                  # level-0 catalog
ctx://skills/{skill}/SKILL.md
ctx://skills/{skill}/references/{path}
ctx://skills/{skill}/scripts/{path}
ctx://docs/{collection}/{path}               # normalized markdown
ctx://docs/{collection}/{path}#chunk={id}    # link-only, returned by search
```

RAG corpora and skills share one tree because a skill bundle *is* a directory and
a corpus *is* a directory. One `cx_read` works on both.

## Progressive disclosure contract

This is the product, not an optimization, so it is enforced in code:

- **L0 — `ctx://index` / `cx_ls("/")`** — every skill's name and description,
  every collection's summary and doc count. Only `ready` sources count as
  documents; a scanned PDF is reported separately as not searchable, so the
  catalog never promises text it does not have. Hard budget: **≤2k tokens**. When the
  corpus outgrows it, descriptions are clipped before any entry is dropped, and
  anything held back is stated rather than silently omitted.
- **L1 — `cx_skill(name)` or `cx_search(...)`** — SKILL.md plus a file manifest,
  or ranked snippets with `resource_link`s. No full documents.
- **L2 — `cx_read(uri)`** — one reference file, or one chunk plus neighbours.
  Binary assets (logos, screenshots, extracted images) come back inline as an
  image or embedded-resource block up to 3 MiB, because an agent cannot fetch
  Resources on its own. `resources/read` has its own, higher ceiling
  (`CONTEXTUAL_MAX_RESOURCE_BLOB_BYTES`), so one `@`-mention of a large asset
  cannot exhaust the server.

Every tool has a hard output cap (`BUDGET` in `src/mcp/format.ts`). Over-cap
results truncate and return a pointer to read the rest — never a silent dump.

## Ingest

`detect → (skill | document) → chunk → embed → write → notify`, with a content
hash on `sources` making re-ingest idempotent.

- **Skills** are validated against the real frontmatter spec: `name` ≤64 chars,
  lowercase/digits/hyphens, no XML tags, no reserved words; `description`
  non-empty and ≤1024 chars, no XML tags; `compatibility` ≤500 chars, stored and
  shown by `cx_skill`. The bundle tree is stored **verbatim** and `SKILL.md` is
  **never chunked** — it is authored to be read whole. Reference files are
  chunked and embedded for search. A `.zip` is inspected before extraction:
  entries with `..`, absolute paths or symlinks, more than 2000 entries, or over
  256 MiB uncompressed are rejected. A **directory bundle carries the same caps**
  and skips dotfiles at every level, so `contextual add .` on a repository that
  happens to have a `SKILL.md` cannot publish its `.env`. Symlinks are never
  followed. A directory *of sources* is walked at most 8 levels deep and 1000
  entries wide.
- **Archives** with `.zip` or `.skill` extensions ingest every bundle they contain,
  in deterministic order. Unknown frontmatter keys fail validation by default;
  `--lenient` warns and omits those fields from indexed metadata while preserving
  the authored SKILL.md. Tool permissions accept whitespace, commas, or YAML
  lists, including entries such as `Bash(git add *)`.
- **Renames are renames.** Re-ingesting a bundle whose `SKILL.md` name changed
  replaces the old skill; a document with identical bytes whose old path no
  longer exists is reclaimed under the new name. `contextual remove` and every
  re-ingest also delete the binary assets they orphan, so the blob directory
  is cleaned after successful replacement. New blobs use unique staging directories;
  a failed transaction removes its staged files and preserves the previous source.
- **Documents** are normalized with [`@firecrawl/anydoc`](https://github.com/firecrawl/anydoc),
  which covers Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV and PDF
  through one document model. Format is detected from the **bytes**, not the
  extension. Unknown binaries and invalid text encodings fail explicitly;
  UTF-8 and BOM-marked UTF-16 are decoded without replacement characters.
  Empty documents are reported as failed. HTML conversion preserves GFM tables,
  strikethrough, and task lists.
- **Chunking** walks the document model rather than re-parsing serialized
  markdown, so `heading_path` falls out of the tree. ~800-token windows with
  ~100 tokens of overlap. Oversize paragraphs and lists split at sentence/item
  boundaries, with a hard bound for a single very long item. Large tables split
  into row batches with repeated headers; fenced code remains atomic.
- **Embedding** sends Voyage `truncation: true` and batches by count *and*
  estimated tokens. A batch the API rejects is retried one chunk at a time, so
  one oversize code block leaves only itself without a vector instead of its whole
  source. The HNSW index is partial (`WHERE embedding IS NOT NULL`) and is
  dropped and rebuilt around any load past `CONTEXTUAL_BULK_INDEX_THRESHOLD`
  (default 2000 vectors), which covers `reindex --all` and all sources in one
  `add` invocation. Source writes finish before one aggregate embedding pass.
  A smaller `add` pays the incremental cost rather than dropping an index other
  queries are using. The rebuild is in a `finally`, so a failed load cannot
  leave the corpus unindexed. Requests have timeouts, bounded retries with
  jitter, and support both forms of `Retry-After`. Authentication and input
  failures are classified separately. A failed embedding run leaves full-text
  retrieval available for a later `reindex`.

### Three things worth knowing

**`toDocument()` does not support PDF.** anydoc converts PDFs with pdf-inspector,
which emits Markdown directly and has no document-model form. `document.ts`
therefore has two paths, and `blocksFromMarkdown` reconstructs the same block
stream for PDFs so the chunker never has to care which it is looking at.

**HTML is not an anydoc format.** It keeps a `@mozilla/readability` + `turndown`
path, routed from `detect.ts`.

**Scanned PDFs fail loudly.** anydoc reads a PDF's text layer only. A scanned
document lands as `status='needs_ocr'`, is surfaced in `contextual list` and in
`ctx://index`, and ingests nothing — rather than silently storing an empty
document. Opting into `CONTEXTUAL_OCR=hosted` sends the file to Firecrawl Parse;
that is a privacy decision, so it is never on by default and **the file leaves
your machine**.

## Retrieval

One SQL statement per query combines `ts_rank_cd` over `chunks.ts` and cosine
`<=>` over `chunks.embedding`, fused with reciprocal rank fusion. The shared
scope CTE is inlined, and vector candidates are selected before window ranking.
Transaction-local HNSW settings enable iterative scoped scans. An `EXPLAIN`
regression checks that both GIN and HNSW remain usable on a representative corpus.

`cx_search` takes an **array of queries** and merges the results, so an agent
spends one round trip on a multi-part question. Its `scope` is strict:
`skills`, `docs`, `skills/{name}` or `docs/{collection}` — anything else is an
error rather than a silent search of everything. Round-robin reservations keep
independent queries represented; near-duplicate passages are removed and results
are capped at three per document. This can return fewer than the requested limit.
Document/collection names and full heading paths prefix the text indexed for
FTS and embeddings without appearing in `cx_read` content.

Optional reranking uses `rerank-2.5-lite` over the fused candidate set. Set
`CONTEXTUAL_RERANK=true` with a Voyage key to enable it; this sends candidate
passages to Voyage. On API failure the ordinary fused ranking is retained.

`cx_grep` runs entirely in Postgres: the file-level match is served by a trigram
index on `nodes.content`, and lines are extracted with `regexp_split_to_table`,
so no whole document is ever loaded into the server to be scanned. Patterns are
Postgres regular expressions, which do not support named groups.

Postgres resists the classic catastrophic-backtracking patterns, but that is not
a bound: a pattern with no indexable trigram degrades to a sequential scan whose
cost grows with the corpus. So grep runs under a **statement timeout**
(`CONTEXTUAL_GREP_TIMEOUT_MS`, default 5s) applied with `SET LOCAL` inside a
transaction, which cannot leak onto a pooled connection. A cancelled query comes
back as an over-expensive pattern with advice, not as an internal error.

`path_glob` is matched against the **VFS path** an agent sees (`/skills/pdf/**`),
not the source-relative path stored in the database. `cx_glob` and `cx_grep`
share one translation, so a pattern copied from one works in the other. Globs
support `*`, `**`, `?`, braces, and character classes; malformed or nested brace
patterns fail explicitly. Exact matching happens before SQL limits. Directory
listings aggregate immediate children in SQL and expose an `offset` continuation.

## Security

Uploaded skills and documents become *instructions* in an agent's context — a
malicious skill is an agent hijack. Therefore:

- **Uploaded scripts are never executed server-side.** They are read-only
  resources; execution stays with the client, in its own sandbox.
- **Path traversal is rejected, not normalized** (`src/core/vfs/uri.ts`): `..`,
  `~`, absolute paths, backslashes, Windows drive letters, null bytes and
  percent-encoded variants all fail. Rejecting rather than resolving keeps two
  URIs from addressing one node.
- Retrieved **documents, search hits and grep hits** are framed as **data, not
  instructions**, in an `<contextual-content untrusted>` envelope. A body that
  contains the envelope's closing tag is cut there and the cut is announced.
  Metadata is escaped too, including headings and filenames.
- **Skills are instructions, and are returned bare.** The split is by *content
  kind*, not by which tool was called: `SKILL.md` is instructions whether it
  arrives from `cx_skill` or from `cx_read` of its URI, because an agent that
  follows a `resource_link` must not be told to disregard bytes it was just told
  to follow. A skill's reference, script and asset files are ordinary content and
  stay enveloped. The trust boundary for skills is ingest-time validation plus
  the human who ran `contextual add`.
- **`allowed-tools` is advisory.** It is stored and shown by `cx_skill` with a
  note that enforcement is the client's job; this server cannot stop a skill
  from asking for Bash.
- **Single-tenant v1 has no auth, by design.** Do not expose this to a network.
  It binds to a local stdio transport and assumes one trusted user, and
  `docker-compose.yml` publishes Postgres on `127.0.0.1` only — the default
  credentials are not a secret.

## Layout

```
db/migrations/             001–005: schema, retrieval context, URIs, notifications
src/
  core/                     # transport-agnostic — survives the move to hosted
    db.ts                   # Bun.sql + pgvector + settings + migrations
    tokens.ts               # BUDGET + estimateTokens (re-exported by mcp/format)
    ingest/  detect skill document chunk embed pipeline
    vfs/     uri resolve list glob grep
    search/  hybrid rrf
    catalog/ index watch
  mcp/       server resources tools format
  cli/       contextual.ts
test/                       # bun test
```

Keeping `core/` free of MCP types is what makes a later HTTP/multi-tenant server
additive rather than a rewrite; `test/layering.test.ts` fails if anything under
`src/core/` imports from `src/mcp/`.

## Runtime notes

Bun is the runtime and package manager. There is no build step — `bun run
src/mcp/server.ts` *is* the server; `tsconfig.json` exists for editor types and
`bun run typecheck`.

**stdout is the JSON-RPC channel.** A single stray `console.log` corrupts the
stream and hangs the client, so all logging goes to stderr via `log()` in
`src/mcp/format.ts`, and a test fails the build if `console.log` appears anywhere
under `src/mcp/`. The server also attaches an `error` listener to stdout and
exits cleanly on `EPIPE`, which the SDK otherwise raises as an unhandled
exception when a client disconnects abruptly.

Migrations are embedded as text imports, so checkout paths with spaces and the
standalone executable use the same SQL. Each migration and its tracking record
commit in one transaction. The explicit `pgArray()` literal remains for stable
binding behavior: the Bun 1.4.2 probe still showed double-quoted values from
`sql.array()`, while the literal helper passes the round-trip regression.

Database triggers update a durable corpus version and issue `NOTIFY` on commit.
Bun's dedicated `sql.listen()` connection checks that version on reconnect,
covering writes missed while disconnected. Idle servers do not poll the corpus.
Change reads are paginated; transient failures retry with bounded backoff.
A polling fallback remains for older, unsupported Bun runtimes.

The MCP SDK v2 stdio entry handles both 2025 initialization and actual
2026-07-28 per-request envelopes, including `server/discover` and `resultType`.
Legacy clients use `resources/subscribe`; modern clients opt in through
`subscriptions/listen`. The SDK filters notifications by the requested URI/type.
`resources/list` remains paginated. Missing resources use the SDK's typed
`ResourceNotFoundError` (`-32602` with `data.uri`). All six tools declare read-only
and idempotent annotations. URI segments are percent-encoded canonically;
spaces, Unicode, literal percent signs, `#`, and `?` are addressable on both surfaces.

## Commands

```
contextual add <path...>        Ingest a skill bundle, a document, or a directory
contextual list                 Show what is ingested, with the index token cost
contextual reindex [--all]      Embed chunks that have no vector yet
contextual remove <kind> <name> Remove a source
contextual migrate              Apply database migrations
contextual serve                Run the MCP stdio server
```

| Flag | Meaning |
|---|---|
| `--collection <name>` | Collection for ingested documents |
| `--lenient` | Warn and ignore unknown skill metadata fields |
| `--force` | Re-ingest even when the content hash is unchanged |
| `--all` | `reindex`: re-embed everything and re-pin the model |
| `--allow-reserved` | Permit `claude`/`anthropic` in a skill name |
| `--json` | Machine-readable output |

### On `--allow-reserved`

The spec reserves `anthropic` and `claude` in skill names so third-party skills
cannot impersonate first-party ones. Anthropic's own published bundles are exempt
— `anthropics/skills` ships `claude-api` — so enforcing the rule blindly makes
real, publisher-authored bundles un-ingestable. The default is spec-conformant;
the flag exists for exactly that case.

## Tests

```bash
bun test          # unit + real Postgres + both MCP protocol eras
bun run typecheck
bun run lint
bun run eval      # isolated, offline retrieval smoke evaluation
bun run test:binary # compile and test migrations, native DOCX ingest, and MCP
```

The integration and server suites create a throwaway Postgres schema, ingest real
files, and drive the server over an actual pipe — the only way to catch the two
classes of bug that unit tests cannot see: SQL binding behaviour, and stdout
contamination.

Database suites skip cleanly with a start-Postgres message when unavailable;
CI sets `CONTEXTUAL_REQUIRE_DB_TESTS=1` to make unavailable Postgres a failure.
Each suite restores its database environment and preserves existing URL options.

## Upgrading an existing corpus

```bash
bun install
bun run migrate
bun run src/cli/contextual.ts reindex --all   # requires VOYAGE_API_KEY
```

Migration 003 removes file-level FTS, adds indexed chunk context, and clears
old embeddings so they can be regenerated consistently. Full-text search remains
available throughout. Migration 004 rewrites existing URIs canonically;
migration 005 installs change notifications. The default model is now `voyage-4`;
a corpus pinned to the old model requires `reindex --all` to switch.

## Distribution and evaluation

`bun run build` creates `dist/contextual` for the current platform with its Bun
runtime, native parser, and migrations embedded. `bun run test:binary` verifies
it outside the checkout, including a directory with spaces. The npm package
ships the Bun launcher and source; `bun pm pack` previews that distribution.
GitHub Actions runs lint, types, Postgres/MCP tests, retrieval evaluation, and
the compiled-binary smoke test. No package is published automatically.

The default evaluation uses a small synthetic corpus and reports recall@5 and
MRR. `bun run eval --voyage` additionally compares plain/prefixed `voyage-4`,
`voyage-context-4`, and float/halfvec/int8/binary representations on those fixtures.
It requires a key and makes billed API requests. This is an exploratory quality
comparison, not an HNSW index-size or production-corpus benchmark; retain the
float schema until representative measurements justify changing it.

## Environment reference

Numeric settings are validated by `src/core/config.ts`; the CLI help uses the
same defaults. Invalid values fail with the setting name instead of becoming NaN.

| Variable | Default / purpose |
|---|---|
| `CONTEXTUAL_DATABASE_URL` | Local Docker Postgres on port 55432 |
| `VOYAGE_API_KEY` | Optional Voyage authentication |
| `CONTEXTUAL_VOYAGE_API_KEY` | Alias for `VOYAGE_API_KEY` |
| `CONTEXTUAL_EMBED_MODEL` | `voyage-4`, 1024 dimensions |
| `CONTEXTUAL_FTS_LANGUAGE` | `english`; pinned on a new database |
| `CONTEXTUAL_OCR` | `reject`; `hosted` opts into external OCR |
| `FIRECRAWL_API_KEY` | Hosted OCR authentication |
| `CONTEXTUAL_BLOB_DIR` | `./blobs` |
| `CONTEXTUAL_RERANK` | `false`; enables external passage reranking |
| `CONTEXTUAL_RERANK_MODEL` | `rerank-2.5-lite` |
<!-- numeric-settings:start -->
| `CONTEXTUAL_SEARCH_TIMEOUT_MS` | 10000; allowed 1–3600000 |
| `CONTEXTUAL_GREP_TIMEOUT_MS` | 5000; allowed 1–3600000 |
| `CONTEXTUAL_MAX_DISTANCE` | 1; allowed 0–2 |
| `CONTEXTUAL_BULK_INDEX_THRESHOLD` | 2000; allowed 0–1000000000 |
| `CONTEXTUAL_MAX_RESOURCE_BLOB_BYTES` | 12582912; allowed 1–1073741824 |
| `CONTEXTUAL_RESOURCE_PAGE` | 100; allowed 1–1000 |
| `CONTEXTUAL_WATCH_MS` | 3000; allowed 50–3600000 |
| `CONTEXTUAL_VOYAGE_TIMEOUT_MS` | 30000; allowed 1–3600000 |
| `CONTEXTUAL_VOYAGE_MAX_ATTEMPTS` | 6; allowed 1–10 |
| `CONTEXTUAL_VOYAGE_RETRY_MAX_MS` | 120000; allowed 1–3600000 |
<!-- numeric-settings:end -->

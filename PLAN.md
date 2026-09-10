# contextual — a context service for agents

> **Status: this is the original design plan, not the implemented contract.**
>
> The build has moved past it in ways that matter, and following the plan alone
> will unteach fixes that two architecture reviews put in. Where the two
> disagree, the code and `README.md` win. Specifically, the plan does not
> describe:
>
> - `db/migrations/002_scale_and_settings.sql` — the `settings` table (FTS
>   configuration and embedding-model pins), the `pg_trgm` index behind
>   `cx_grep`, the partial HNSW index, and `skills.compatibility`.
> - **Ingest guards.** Zip archives are inspected before extraction (no
>   symlinks, no `..`, capped entries and bytes); directory bundles carry the
>   same caps and skip dotfiles; a directory of sources is bounded in depth and
>   width.
> - **The envelope split.** Documents, search hits and grep hits are framed as
>   untrusted data; `SKILL.md` is instructions, whether it is loaded with
>   `cx_skill` or read by URI with `cx_read`.
> - **Binary reads.** `cx_read` returns image and embedded-resource blocks
>   inline rather than deferring to the Resources surface.
> - **Transport and protocol.** Postgres binds to `127.0.0.1`; `resources/list`
>   is paginated; `resources/updated` is sent to listen-style clients on
>   protocol `2026-07-28` as well as to subscribers.
> - **Query bounds.** `cx_grep` and the search path run under a statement
>   timeout, and `path_glob` is a VFS path, not a source-relative one.


## Context

Agents need domain knowledge (RAG corpora) and procedural expertise (Anthropic-format Agent Skills), but today both get stuffed into context wholesale or wired up ad hoc per project. **contextual** is a service that ingests uploaded documents and skill bundles, digests them, and republishes them as a single addressable virtual filesystem that agents browse lazily — reading only what they need, when they need it.

The design goal is *progressive disclosure*, the same principle behind Anthropic's skill format: a cheap always-available catalog at level 0, targeted reads at level 1, deep bundle files at level 2. Nothing enters an agent's context unless the agent asked for it.

### One finding that shapes the whole architecture

MCP **Resources are application-driven, not model-driven**. The spec states host applications decide how to incorporate resource context, and in Claude Code resources are pulled in by a user typing `@server:resource`. **An agent cannot autonomously list or read Resources.** A Resources-only VFS would be inert for the primary use case.

So contextual ships **two surfaces over one URI namespace**:

| Surface | Controlled by | Purpose |
|---|---|---|
| **Tools** (`cx_ls`, `cx_glob`, `cx_grep`, `cx_read`, `cx_search`, `cx_skill`) | the model | Agent autonomy — this is how the VFS actually gets used |
| **Resources** (`resources/list`, `/read`, `/templates/list`, `/subscribe`) | the host app / human | Stable addressability, `@`-mentions, citability, change notifications |

They are not two systems. Tool results return MCP `resource_link` content blocks pointing back into the Resources namespace — so a search hit is a *citation*, and the agent (or the human) can follow it. Per spec, resource links returned by tools need not appear in `resources/list`, which lets us link to chunk-level URIs without listing millions of them.

### Confirmed decisions
Hybrid Tools+Resources · local single-tenant stdio first · TypeScript on **Bun** · Postgres + pgvector.

Postgres in the local phase is deliberate: it holds full-text (`tsvector`) *and* vectors in one query, so hybrid retrieval is one SQL statement and there is no storage rewrite when this becomes a hosted service.

---

## Runtime & toolchain (Bun)

Bun is the runtime and the package manager. Concretely this removes three moving parts the plan would otherwise carry:

- **No build step.** Bun executes `.ts` directly, so `bun run src/mcp/server.ts` *is* the server. `tsconfig.json` exists for editor types and `bun run typecheck` only. Nothing in the milestones needs `tsc` output.
- **No `pg` dependency.** `Bun.sql` is a built-in Postgres client (tagged-template queries, pooling, transactions, prepared statements), and the `pgvector` npm package ships a Bun SQL adapter — so `db.ts` binds vectors natively rather than hand-serializing `'[...]'::vector`.
- **No test framework dependency.** `bun test` is built in and Jest-compatible; test files are `*.test.ts`.

`package.json` scripts: `serve` (`bun run src/mcp/server.ts`), `ingest` (`bun run src/cli/contextual.ts add`), `migrate`, `test`, `typecheck`. The MCP TypeScript SDK officially supports Bun, so `@modelcontextprotocol/sdk` needs no shims.

**One stdio hazard to design around from Milestone 1.** With `StdioServerTransport`, stdout is the JSON-RPC channel — a single stray `console.log` corrupts the stream and the client hangs. All logging goes to **stderr** via a `log()` helper in `src/mcp/format.ts`, and `console.log` is banned in `src/mcp/`. Separately, the SDK has a known crash where an abrupt client disconnect raises an unhandled `EPIPE`; attach an `error` listener to stdout and exit gracefully.

---

## The namespace

```
ctx://index                                  # level-0 catalog — always cheap to read
ctx://skills/{skill}/SKILL.md
ctx://skills/{skill}/references/{path}
ctx://skills/{skill}/scripts/{path}
ctx://skills/{skill}/assets/{path}
ctx://docs/{collection}/{path}               # normalized markdown of an uploaded doc
ctx://docs/{collection}/{path}#chunk={id}    # link-only, returned by search, never listed
```

RAG and skills share one tree because a skill bundle *is* a directory and a corpus *is* a directory. One `cx_read` works on both.

**Resource registration** (`@modelcontextprotocol/sdk`):
- `registerResource` for the fixed `ctx://index`.
- `ResourceTemplate('ctx://skills/{skill}/{+path}', { list, complete })` and the same for `docs` — the `complete` callback autocompletes skill and collection names from the DB.
- `resources/list` returns only meaningful entries: `ctx://index`, one `SKILL.md` per skill, one entry per doc. Not every asset, never a chunk.
- On re-ingest, emit `notifications/resources/list_changed`; for subscribed URIs emit `notifications/resources/updated`.

---

## Progressive disclosure contract

This is the product, not an optimization. Enforce it in code:

- **L0 — `ctx://index` / `cx_ls("/")`**: every skill's `name` + `description`, every collection's summary and doc count. Hard budget: **≤ 2k tokens**. An agent reads this once and knows what exists.
- **L1 — `cx_skill(name)` or `cx_search(...)`**: SKILL.md body + file manifest, or ranked snippets + `resource_link`s. No full documents.
- **L2 — `cx_read(uri)`**: one reference file, or one chunk plus neighbors.

Every tool has a hard output cap. Over-cap results truncate and return a pointer to read the rest — never a silent dump. (Mirrors deepagents' `FilesystemMiddleware`, which evicts oversized tool results to the filesystem rather than letting them saturate context.)

---

## Ingest pipeline

`src/core/ingest/pipeline.ts` — content-hash on `sources` makes re-ingest idempotent.

1. **Detect** (`detect.ts`) — `SKILL.md` at bundle root (or inside a zip) ⇒ skill; otherwise document.
2. **Skill** (`skill.ts`) — parse + **validate frontmatter against the real spec**: `name` ≤64 chars, lowercase/digits/hyphens only, no XML tags, no reserved words (`anthropic`, `claude`); `description` non-empty and ≤1024 chars, no XML tags. Allowed keys: `name`, `description`, `allowed-tools`, `compatibility`, `license`, `metadata`. Store the tree **verbatim** — do **not** chunk `SKILL.md`; it is authored to be read whole. Reference files may be chunked and embedded for search.
3. **Document** (`document.ts`) — normalize via **[`@firecrawl/anydoc`](https://github.com/firecrawl/anydoc)** (MIT; Rust core, Node bindings). One library replaces the `unpdf`/`mammoth` stack and covers 14 formats — Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF, text. Everything except PDF goes through a single document model and one Markdown serializer, so a 2003 `.doc` and a modern `.pptx` produce identically-shaped output. **PDF is the exception:** anydoc converts it with pdf-inspector, which emits Markdown directly and has no document-model form, so `toDocument()` throws `unsupported` for it and `document.ts` calls `toMarkdownBytes()` instead (pinned by `test/anydoc.test.ts`). Pure Rust, no ML models, no network, median <5ms/doc; conversion runs on the libuv thread pool so it never blocks the event loop. See **Document normalization** below for the API and the two gaps it does not cover.
4. **Chunk** (`chunk.ts`) — walk anydoc's **document model**, not the serialized markdown. The model exposes blocks, inlines, tables, footnotes and headings-with-anchors directly, so `heading_path` falls out of the tree instead of being recovered by re-parsing `#` prefixes. Split on heading boundaries first, then ~800-token windows with ~100-token overlap; never split a fenced code block or a table.
5. **Embed** (`embed.ts`) — Voyage `voyage-3.5` at 1024 dims (32K context, Matryoshka-truncatable). Behind an `Embedder` interface so it is swappable; batch + retry.
6. Write, then notify resource subscribers.

## Document normalization (anydoc)

`document.ts` calls `toDocument()` rather than `toMarkdown()` for every format that has a document model. Stopping at the model is what makes the rest of the pipeline work: it carries the heading tree the chunker needs *and* the embedded image bytes tagged by media type, which land in `nodes` as `role='asset'` with a `blob_ref` — the same treatment skill bundles already get. Markdown is then serialized from that same model for `ctx://docs/{collection}/{path}`.

```ts
import { toDocument, toMarkdownBytes } from '@firecrawl/anydoc';
const doc = await toDocument(bytes);         // docx, pptx, xlsx, odt, rtf, epub, csv: blocks, inlines, tables, footnotes, assets
const md  = await toMarkdownBytes(bytes);    // pdf only: toDocument() throws `unsupported` for PDF
```

**Do not route PDF through `toDocument()`.** pdf-inspector has no document-model form; the call throws with code `unsupported`. `blocksFromMarkdown` in `chunk.ts` rebuilds the same block stream from the Markdown so the chunker never has to know which path produced it.

Format is detected from the **bytes** (PDF header, RTF open group, OLE stream names, ZIP package mimetype), not the file extension — so a mislabeled upload still converts correctly. Useful, because uploads are exactly where extensions lie.

### Two gaps anydoc does not cover

- **HTML is not a supported format.** Keep `@mozilla/readability` + `turndown` on the HTML/web-page path and route to it in `detect.ts`. anydoc handles everything else.
- **Scanned PDFs fail with `NeedsOcr`.** anydoc reads a PDF's text layer only; there is no local OCR. Two options, and the choice is a privacy decision, not a technical one:
  - **Default — fail loudly.** Mark the source `status='needs_ocr'`, surface it in `contextual list` and in `ctx://index`, and ingest nothing. A local-first single-tenant service should not silently ship user documents off the machine.
  - **Opt-in** `ocr: 'hosted'`, which sends the document to Firecrawl Parse. Requires an API key and network egress. Gate it behind an explicit config flag (`CONTEXTUAL_OCR=hosted`), never on by default, and document that the file leaves the machine.

### Risk: native addon under Bun

`@firecrawl/anydoc` is a **native N-API addon**, and Bun runs JavaScriptCore rather than V8. napi-rs treats Bun as best-effort in CI, not a guaranteed target — so this needs a ~10-minute spike as **Milestone 0**, before any pipeline code depends on it. Fallbacks in order of preference:

1. Native `@firecrawl/anydoc` under Bun — verify `toDocument()` loads and returns on a real `.docx`, and `toMarkdownBytes()` on a real `.pdf`.
2. **`@firecrawl/anydoc-wasm`** — the WebAssembly build, runtime-agnostic and certain to load under Bun; costs some of the <5ms speed, which is irrelevant at ingest time.
3. Shell out to the anydoc CLI from `document.ts`.

Ingest is a batch path, not a request path, so option 2 or 3 is an acceptable landing spot. Do not let this decision block the schema or chunker work.

## Schema (`db/migrations/001_init.sql`)

```sql
sources(id, kind 'skill'|'doc', name, collection, origin_uri, content_hash,
        status 'ready'|'needs_ocr'|'failed', created_at, updated_at)
nodes(id, source_id, path, uri UNIQUE, mime_type, size_bytes,
      role 'skill_md'|'reference'|'script'|'asset'|'doc', content text, blob_ref,
      ts tsvector GENERATED)
chunks(id, node_id, ord, heading_path text[], content text, token_count,
       ts tsvector GENERATED, embedding vector(1024))
skills(source_id PK, name UNIQUE, description, allowed_tools text[], license, metadata jsonb)
```
Indexes: GIN on both `ts` columns; HNSW (`vector_cosine_ops`) on `chunks.embedding`.

## Hybrid retrieval (`src/core/search/hybrid.ts`)

One statement, two CTEs — `ts_rank_cd` over `chunks.ts` and cosine `<=>` over `chunks.embedding` — fused with reciprocal rank fusion (`1/(60+rank)`). Returns snippet + `heading_path` + chunk URI. `cx_search` accepts an **array of queries** in one call and merges results, so an agent spends one round-trip on a multi-part question.

---

## Repo layout

```
contextual/
  package.json                  # scripts: serve | ingest | migrate | test
  bunfig.toml
  tsconfig.json                 # types only — Bun executes .ts directly, no build step
  docker-compose.yml            # postgres + pgvector
  db/migrations/001_init.sql
  src/
    core/                       # transport-agnostic — survives the move to hosted
      db.ts                     # Bun.sql + pgvector's Bun adapter
      ingest/  detect.ts skill.ts document.ts chunk.ts embed.ts pipeline.ts
      vfs/     uri.ts resolve.ts list.ts glob.ts grep.ts
      search/  hybrid.ts rrf.ts
      catalog/ index.ts
    mcp/     server.ts resources.ts tools.ts format.ts   # resource_link + truncation helpers
    cli/     contextual.ts       # add | list | reindex | serve
  test/                         # bun test — *.test.ts
```

Keeping `core/` free of MCP types is what makes the later HTTP/multi-tenant server additive rather than a rewrite.

---

## Milestones

| # | Milestone | What ships | Files | Done when |
|---|---|---|---|---|
| 0 | **Spike: anydoc under Bun** | Confirm `@firecrawl/anydoc` (native N-API) loads under Bun's JavaScriptCore; else fall back to `@firecrawl/anydoc-wasm`, else the CLI | throwaway | `toDocument()` returns a model for a real `.docx`; `toMarkdownBytes()` returns Markdown for a real `.pdf` (and `toDocument()` on it throws `unsupported`) |
| 1 | **Skeleton** | Postgres + pgvector via compose, migrations, `Bun.sql` connection, stdio server serving a hardcoded `ctx://index` | `docker-compose.yml`, `db/migrations/001_init.sql`, `core/db.ts`, `mcp/server.ts`, `mcp/format.ts` | MCP Inspector connects; `resources/read ctx://index` returns; pgvector extension loads; **nothing but JSON-RPC on stdout** |
| 2 | **Skills end-to-end** | Skill detection, frontmatter validation, verbatim tree storage, first three tools, resource templates with completion | `ingest/detect.ts`, `ingest/skill.ts`, `vfs/uri.ts`, `vfs/resolve.ts`, `vfs/list.ts`, `mcp/tools.ts`, `mcp/resources.ts` | A real bundle from `anthropics/skills` ingests; `cx_ls` → `cx_skill` → `cx_read` walks it; `SKILL.md` stored **unchunked**; completion returns skill names |
| 3 | **Documents + retrieval** | anydoc normalization, model-walking chunker, Voyage embeddings, hybrid search | `ingest/document.ts`, `ingest/chunk.ts`, `ingest/embed.ts`, `ingest/pipeline.ts`, `search/hybrid.ts`, `search/rrf.ts` | A PDF and a `.docx` ingest with correct `heading_path`; `cx_search` returns snippets + `resource_link`s; a scanned PDF lands `status='needs_ocr'` instead of ingesting empty text |
| 4 | **VFS polish** | Remaining filesystem tools, the disclosure budgets, security guards, change notifications | `vfs/glob.ts`, `vfs/grep.ts`, `catalog/index.ts`, `mcp/format.ts` | Every tool respects its output cap; `ctx://index` under 2k tokens with ≥20 skills; `..`/`~`/absolute escapes rejected; re-ingest fires `list_changed` |
| 5 | **CLI + docs** | `contextual add \| list \| reindex \| serve`, README, `.mcp.json` snippet | `cli/contextual.ts`, `README.md` | **The real test:** a fresh Claude Code session with no `@`-mentions answers a question only an ingested doc contains, reaching it via `cx_ls` → `cx_search` → `cx_read` |

Two notes on ordering. **Milestone 0** is split out because it is the one unresolved external dependency and it gates `ingest/document.ts` — if it fails you want to know before writing the chunker, not during. **Milestone 2 ships skills before documents** because skills need no embeddings, no API key and no anydoc, so the whole Tools+Resources surface gets proven against a real bundle while the dependency surface is still near zero.

---

## Security

Uploaded skills and documents become *instructions* in an agent's context — a malicious skill is an agent hijack. Therefore:
- **Never execute uploaded scripts server-side.** Scripts are read-only resources; execution stays with the client, in its own sandbox, as Anthropic's model intends.
- **Path-traversal guards** in `vfs/resolve.ts`: reject `..`, `~`, and any absolute escape from a source root (the same guardrail deepagents' `virtual_mode` provides).
- Frame retrieved content as **data, not instructions**, in tool result envelopes.
- Single-tenant v1 has no auth by design — document this loudly so it isn't exposed to a network before the hosted phase adds isolation.

## Open question (non-blocking)

Your `~/CLAUDE.md` describes an existing **context-mode** MCP server that already owns the `ctx_*` tool namespace (`ctx_search`, `ctx_index`, `ctx_fetch_and_index`, `ctx_stats`) and an FTS5 knowledge base — conceptually adjacent to this. I've used the **`cx_*`** prefix here to avoid a live collision. Worth deciding later whether contextual supersedes context-mode or sits beside it; it does not block any milestone.

---

## Verification

1. `docker compose up -d` → run migrations → confirm `pgvector` extension loads.
2. `contextual add ./skills/pdf` (a real Anthropic skill bundle) and `contextual add ./sample.pdf` → assert rows in `sources`/`nodes`/`chunks` and that `SKILL.md` was stored unchunked.
   Convenient fixture: anydoc ships its own Agent Skill at [`skills/convert-documents-to-markdown/SKILL.md`](https://github.com/firecrawl/anydoc/blob/main/skills/convert-documents-to-markdown/SKILL.md) — a real third-party bundle for the skill path, from the same dependency driving the doc path.
   Also assert the OCR path: feed a scanned PDF and confirm it lands as `status='needs_ocr'` rather than silently ingesting empty text.
3. **MCP Inspector** (`bunx @modelcontextprotocol/inspector`): exercise `resources/list` (paginated), `resources/templates/list` (completion returns skill names), `resources/read`, and `resources/subscribe` — then re-ingest and confirm `list_changed` fires.
4. **The real test** — register in `.mcp.json`, and from a *fresh* Claude Code session with no `@`-mentions, ask a question answerable only from an ingested doc. The agent must get there on its own: `cx_ls("/")` → `cx_search` → `cx_read`. If a human has to mention a resource, the tool surface has failed.
5. Assert `ctx://index` stays under its 2k-token budget with ≥20 skills ingested, and that every tool respects its output cap.
6. `bun test` on the parts with real edge cases: frontmatter validation (all limits + reserved words), chunker (code fences, heading paths), RRF fusion ordering, URI resolution and traversal rejection.

## Sources
- [MCP Resources spec](https://modelcontextprotocol.io/specification/2025-06-18/server/resources) · [MCP Tools spec (`resource_link`)](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) · [Claude Code MCP docs](https://docs.claude.com/en/docs/claude-code/mcp)
- [Agent Skills overview](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview) · [Equipping agents with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) · [anthropics/skills](https://github.com/anthropics/skills)
- [deepagents FilesystemMiddleware](https://reference.langchain.com/python/deepagents/middleware/filesystem/FilesystemMiddleware) · [MCP TypeScript SDK server docs](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md) · [voyage-3.5](https://blog.voyageai.com/2025/05/20/voyage-3-5/)
- [Bun SQL docs](https://bun.sh/docs/runtime/sql) · [pgvector-node (Bun SQL adapter)](https://github.com/pgvector/pgvector-node) · [SDK stdio EPIPE issue](https://github.com/modelcontextprotocol/typescript-sdk/issues/1564)
- [firecrawl/anydoc](https://github.com/firecrawl/anydoc) · [@firecrawl/anydoc on npm](https://www.npmjs.com/package/@firecrawl/anydoc) · [AnyDoc + pdf-inspector announcement](https://www.firecrawl.dev/blog/anydoc-and-pdf-inspector) · [napi-rs](https://napi.rs/)

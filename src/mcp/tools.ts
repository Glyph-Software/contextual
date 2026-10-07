/**
 * The Tools surface: model-driven, and the only way an agent can reach the VFS
 * on its own. Resources are pulled in by the host application, so a
 * Resources-only server would be inert for an autonomous agent.
 *
 * Every tool enforces the progressive-disclosure contract:
 *   L0  cx_ls("/")        — what exists, cheaply
 *   L1  cx_skill / cx_search — instructions, or ranked snippets with citations
 *   L2  cx_read           — one file, or one chunk plus neighbours
 *
 * and every tool caps its output, truncating with a pointer to the rest rather
 * than dumping into context.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ContentBlock } from '@modelcontextprotocol/server';
import { loadCatalog, renderCatalog } from '../core/catalog/index';
import { listPath, renderListing, listingEntryRenderer } from '../core/vfs/list';
import { glob } from '../core/vfs/glob';
import { grepPage, GrepTooExpensiveError } from '../core/vfs/grep';
import { searchWithDiagnostics, SearchTooExpensiveError, type Hit } from '../core/search/hybrid';
import { searchSkills, type SkillHit } from '../core/search/skills';
import type { RetrievalDiagnostics } from '../core/search/diagnostics';
import { sqlState, UNDEFINED_COLUMN, UNDEFINED_TABLE } from '../core/db';
import { InputError } from '../core/errors';
import { resolveNode, resolveChunk, chunkNeighbors, skillByName, nodesOfSource } from '../core/vfs/resolve';
import { INDEX_URI, parseUri, pathToUri, buildUri, UriError } from '../core/vfs/uri';
import { BUDGET, MAX_INLINE_BLOB_BYTES, cap, envelope, errorResult, resourceLink, result, text, log } from './format';
import { CursorError, continuation, decodeCursor, encodeCursor, fitEntries, textPage } from './pagination';
import { decodeGrepCursor, encodeGrepCursor } from './grep-cursor';
import { SearchPages } from './search-pages';
import { safeContentEnd, SUPPRESSION_NOTICE, suppressUnsafeTail } from './content-safety';

type PassageDisplay = Pick<Hit, 'uri' | 'path' | 'headingPath' | 'snippet' | 'sourceName'>;
type SearchSnapshot = { target: 'skills'; hits: SkillHit[] } | ({ target: 'passages'; hits: PassageDisplay[] } & RetrievalDiagnostics);
const searchPages = new SearchPages<SearchSnapshot>();

const cursorInput = z.string().max(512).optional().describe('Opaque next_cursor from the previous response; keep the other arguments unchanged');
const pageOutput = z.looseObject({
  next_cursor: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), suggested_action: z.string() }).optional(),
});

export function registerTools(server: McpServer): void {
  server.registerTool(
    'cx_ls',
    {
      title: 'List the context filesystem',
      outputSchema: pageOutput,
      description:
        'List what is available. Start here: cx_ls("/") is the level-0 catalog — every skill and ' +
        'document collection, cheap enough to read on every session. Then descend: "/skills", ' +
        '"/skills/{name}", "/docs/{collection}".',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: { path: z.string().default('/').describe('VFS directory path'), offset: z.number().int().min(0).default(0), cursor: cursorInput },
    },
    async ({ path, offset, cursor }) => {
      try {
        const key = `ls:${path}`;
        if (cursor && offset) throw new CursorError('Use cursor or offset, not both.');
        const start = decodeCursor(cursor, key) ?? offset;
        // The root listing is the catalog itself, not a two-line directory:
        // one call has to tell an agent everything that exists.
        if (!path || path === '/') {
          const body = renderCatalog(await loadCatalog());
          if (cursor) throw new CursorError('The root is a summary. Browse /skills or /docs to page through entries.');
          return result([text(cap(body, BUDGET.index).text), resourceLink('ctx://index', 'contextual catalog', 'Level-0 catalog', 'text/markdown')], { next_cursor: null });
        }
        const listing = await listPath(path, { offset: start });
        if (listing.missing) return errorResult(renderListing(listing));
        const page = fitEntries(listing.entries, listingEntryRenderer(listing.entries), BUDGET.ls - 256);
        const more = page.entries.length < listing.entries.length || listing.nextOffset !== undefined;
        const next = more ? encodeCursor(key, start + page.entries.length) : null;
        const blocks: ContentBlock[] = [text(`${listing.path}\n${page.body || '(empty)'}` + continuation('cx_ls', { path }, next))];
        for (const e of page.entries.filter((x) => x.uri).slice(0, 25)) {
          blocks.push(resourceLink(e.uri!, e.name, e.note, 'text/markdown'));
        }
        return result(blocks, { next_cursor: next, returned: page.entries.length, next_offset: more ? start + page.entries.length : null });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'cx_glob',
    {
      title: 'Find files by path pattern',
      outputSchema: pageOutput,
      description:
        'Find files by glob against their full VFS path. "**/*.py" finds every script; ' +
        '"/skills/pdf/**" finds one bundle\'s files. Returns paths only — use cx_read to open one.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        pattern: z.string().describe('Glob, e.g. "**/*.md", "/skills/*/references/**"'),
        limit: z.number().int().min(1).max(500).default(100),
        cursor: cursorInput,
      },
    },
    async ({ pattern, limit, cursor }) => {
      try {
        const key = `glob:${JSON.stringify({ pattern, limit })}`;
        const start = decodeCursor(cursor, key) ?? 0;
        const hits = await glob(pattern, limit + 1, start);
        const page = fitEntries(hits.slice(0, limit), (h) => `${h.path}  (${h.role}${h.sizeBytes ? `, ${h.sizeBytes}B` : ''})`, BUDGET.glob - 256);
        const next = hits.length > page.entries.length ? encodeCursor(key, start + page.entries.length) : null;
        return result([
          text((hits.length ? `${page.entries.length} matches:\n${page.body}` : `No files match ${pattern}.`) + continuation('cx_glob', { pattern, limit }, next)),
          ...page.entries.slice(0, 20).map((h) => resourceLink(h.uri, h.path, h.role)),
        ], { next_cursor: next, returned: page.entries.length });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'cx_grep',
    {
      title: 'Search file contents for an exact pattern',
      outputSchema: pageOutput,
      description:
        'Regex search over stored file contents, returning matching lines. Use this for exact or ' +
        'structural matches (a function name, a flag, an error string). For "find passages about X", ' +
        'use cx_search instead — it is ranked and semantic.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        pattern: z.string().describe('Regular expression'),
        path_glob: z.string().optional().describe('Restrict to paths matching this glob'),
        ignore_case: z.boolean().default(true),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: cursorInput,
      },
    },
    async ({ pattern, path_glob, ignore_case, limit, cursor }) => {
      try {
        const args = { pattern, path_glob, ignore_case, limit };
        const key = `grep:${JSON.stringify(args)}`;
        const scan = await grepPage(pattern, { pathGlob: path_glob, ignoreCase: ignore_case, maxMatches: limit, after: decodeGrepCursor(cursor, key) });
        const matches = scan.matches;
        if (!matches.length && !scan.next) {
          return result(
            `No matches for /${pattern}/${path_glob ? ` under ${path_glob}` : ''}.` +
              (path_glob ? ' Paths are VFS paths, as shown by cx_ls — e.g. "/skills/{name}/**".' : ''), { next_cursor: null, returned: 0 },
          );
        }
        const page = fitEntries(matches.slice(0, limit), (m) => `${m.path}:${m.line}: ${m.text}`, BUDGET.grep - 256);
        const last = page.entries.at(-1);
        const next = encodeGrepCursor(key, last && page.entries.length < matches.length ? { nodeId: last.nodeId, line: last.line } : scan.next);
        // Matching lines are document content, so they are framed as data for
        // the same reason cx_read and cx_search are: a line lifted out of an
        // uploaded PDF is not an instruction.
        return result([
          text(envelope(page.body, { pattern, matches: page.entries.length, ...(path_glob && { path_glob }) }) + continuation('cx_grep', args, next)),
          ...dedupeLinks(page.entries.map((m) => resourceLink(m.uri, m.path))).slice(0, 20),
        ], { next_cursor: next, returned: page.entries.length, scanned_files: scan.scannedFiles, content_suppressed: safeContentEnd(page.body) < page.body.length });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'cx_read',
    {
      title: 'Read one file or chunk',
      outputSchema: pageOutput,
      description:
        'Read a single file by ctx:// URI or VFS path. This is the deepest level — read only what ' +
        'cx_ls, cx_search or cx_skill pointed you at. A chunk URI (…#chunk=N) returns that passage ' +
        'plus its neighbours. Follow next_cursor to continue long files, even within a long line.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        uri: z.string().describe('ctx:// URI or VFS path, e.g. "ctx://skills/pdf/SKILL.md" or "/skills/pdf/SKILL.md"'),
        offset: z.number().int().min(0).default(0).describe('Line to start from, for continuing a truncated read'),
        limit: z.number().int().min(1).max(5000).optional().describe('Maximum lines to return'),
        cursor: cursorInput,
      },
    },
    async ({ uri, offset, limit, cursor }) => {
      try {
        const target = uri.startsWith('ctx://') ? uri : pathToUri(uri);
        if (!target) return errorResult(`Not a readable path: ${uri}.`, 'INVALID_ARGUMENT');

        if (target === INDEX_URI) {
          if (cursor) throw new CursorError('The index is a summary. Use cx_ls to browse /skills or /docs.');
          return result(renderCatalog(await loadCatalog()), { next_cursor: null });
        }
        const parsed = parseUri(target);
        const canonical = buildUri(parsed.realm, parsed.root, parsed.path, parsed.chunk);
        if (parsed.chunk !== undefined) return await readChunk(canonical, { offset, limit, cursor });

        const node = await resolveNode(target);
        if (!node) return errorResult(`No such resource: ${target}.`);

        // A binary asset is returned inline — as an image block when it is
        // one, otherwise as an embedded resource — because Resources are
        // host-driven and an agent cannot fetch them on its own. Sending the
        // model to `resources/read` would make every logo and screenshot a
        // dead end on the only surface it can actually use.
        if (node.content === null) {
          if (cursor) throw new CursorError('Binary assets do not support text cursors.');
          return await readBlob(target, node);
        }

        const page = textPage(node.content, `read:${canonical}`, BUDGET.read - 256, { offset, limit, cursor, revision: node.revision, untrusted: node.role !== 'skill_md' });
        const lines = page.text ? `${page.firstLine}-${page.lastLine} of ${page.totalLines}` : 'no lines returned';
        const meta = { uri: canonical, source: node.sourceName, role: node.role, lines, start_character: page.start, end_character: page.end, content_suppressed: page.contentSuppressed };
        // The trust split is by *content kind*, not by which tool was called.
        // A SKILL.md is instructions whether it arrives via cx_skill or via a
        // resource_link followed with cx_read; wrapping it here in "do not
        // follow this" would make the same bytes mean two different things.
        const body = node.role === 'skill_md'
          ? `${Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${page.text}`
          : envelope(page.text + (page.contentSuppressed && !page.nextCursor ? SUPPRESSION_NOTICE : ''), meta);
        return result([
          text(body + continuation('cx_read', { uri: canonical, ...(limit && { limit }) }, page.nextCursor)),
          resourceLink(target, node.path, node.role, node.mimeType ?? 'text/plain'),
        ], { next_cursor: page.nextCursor, ...meta });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'cx_search',
    {
      title: 'Find passages or discover skills by purpose',
      outputSchema: pageOutput.extend({
        retrieval_mode: z.enum(['full_text', 'hybrid', 'skill_metadata']).optional(),
        warnings: z.array(z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), suggested_action: z.string() })).optional(),
      }),
      description:
        'Ranked hybrid search (full-text + semantic) over every ingested document and skill ' +
        'reference. Pass ALL parts of a multi-part question as an array in one call — results are ' +
        'merged and re-ranked together. Returns snippets with citable ctx:// links; follow one with ' +
        'cx_read to see the full passage. Use target="skills" to find skills by name and description ' +
        'without loading instructions; then call cx_skill(name). Check retrieval_mode and warnings for degraded search.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        queries: z.array(z.string()).min(1).max(8).describe('One or more natural-language queries'),
        scope: z.string().optional().describe('Restrict to "skills", "docs", or "docs/{collection}"'),
        limit: z.number().int().min(1).max(25).default(8),
        target: z.enum(['passages', 'skills']).default('passages').describe('Rank passages (default), or discover skills from metadata only'),
        cursor: cursorInput,
      },
    },
    async ({ queries, scope, limit, target, cursor }) => {
      try {
        const args = { queries, scope, limit, target };
        const key = `search:${JSON.stringify(args)}`;
        const saved = cursor === undefined ? undefined : searchPages.read(cursor, key);
        let snapshot: SearchSnapshot;
        if (saved) snapshot = saved.value;
        else if (target === 'skills') snapshot = { target, hits: await searchSkills(queries, { scope, limit }) };
        else {
          const { hits, ...diagnostics } = await searchWithDiagnostics(queries, { limit, scope });
          snapshot = { target, ...diagnostics, hits: hits.map(({ uri, path, headingPath, snippet, sourceName }) => ({ uri, path, headingPath, snippet, sourceName })) };
        }
        const start = saved?.start ?? 0;
        if (start > snapshot.hits.length) throw new CursorError('Search cursor is past the last result.');
        const nextCursor = (count: number) => start + count < snapshot.hits.length
          ? searchPages.cursor(key, saved?.id ?? searchPages.save(key, snapshot), start + count) : null;
        if (snapshot.target === 'skills') {
          const { hits } = snapshot;
          const page = fitEntries(hits.slice(start), (h, i) => `${start + i + 1}. ${h.name}\n   ${h.description}\n   Load with cx_skill(${JSON.stringify({ name: h.name })})\n   ${h.uri}\n`, BUDGET.search - 256);
          const next = nextCursor(page.entries.length);
          return result([
            text((hits.length ? envelope(page.body, { target: 'skill metadata', hits: page.entries.length }) : 'No skills matched. Try different purpose words or browse cx_ls("/skills").') + continuation('cx_search', args, next)),
            ...page.entries.map((h) => resourceLink(h.uri, h.name, suppressUnsafeTail(h.description), 'text/markdown')),
          ], { retrieval_mode: 'skill_metadata', warnings: [], next_cursor: next, returned: page.entries.length,
            content_suppressed: safeContentEnd(page.body) < page.body.length,
            skills: page.entries.map((h) => ({ name: h.name, uri: h.uri, next_call: { tool: 'cx_skill', arguments: { name: h.name } } })) });
        }
        const { hits, retrieval_mode, warnings } = snapshot;
        const diagnostics = { retrieval_mode, warnings };
        const status = `Retrieval: ${diagnostics.retrieval_mode}.\n` + diagnostics.warnings.map((w) => `${w.code}: ${w.message} ${w.suggested_action}\n`).join('');
        if (!hits.length) {
          return result(
            status + `No passages found for ${queries.map((q) => JSON.stringify(q)).join(', ')}` +
              `${scope ? ` in ${scope}` : ''}. Try cx_ls("/") to see what is ingested, or broaden the wording.`,
            { ...diagnostics, next_cursor: null, returned: 0 },
          );
        }
        const page = fitEntries(hits.slice(start), (h, i) => {
            const where = h.headingPath?.length ? ` › ${h.headingPath.join(' › ')}` : '';
            return `${start + i + 1}. ${h.path}${where}\n   ${h.snippet.replace(/\s+/g, ' ').trim()}\n   ${h.uri}\n`;
          }, BUDGET.search - 512);
        const next = nextCursor(page.entries.length);
        return result([
          text(status + envelope(page.body, { queries: queries.join(' | '), hits: page.entries.length }) + continuation('cx_search', args, next)),
          ...page.entries.map((h) => resourceLink(h.uri, suppressUnsafeTail(`${h.sourceName}${h.headingPath?.length ? ` › ${h.headingPath.at(-1)}` : ''}`), suppressUnsafeTail(h.snippet).replace(/\*\*/g, '').slice(0, 160), 'text/markdown')),
        ], { ...diagnostics, next_cursor: next, returned: page.entries.length, content_suppressed: safeContentEnd(page.body) < page.body.length });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'cx_skill',
    {
      title: 'Load an Agent Skill',
      outputSchema: pageOutput,
      description:
        "Load one skill's full instructions (SKILL.md, verbatim) plus a manifest of its bundled " +
        'references, scripts and assets. Read the manifest, then cx_read only the files the task ' +
        'needs. Bundled scripts are never executed by this server — run them in your own sandbox.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: { name: z.string().describe('Skill name, as shown by cx_ls or cx_search with target="skills"'), cursor: cursorInput },
    },
    async ({ name, cursor }) => {
      try {
        const skill = await skillByName(name);
        if (!skill) {
          return errorResult(`No skill named "${name}".`, 'NOT_FOUND', 'Use cx_ls({"path":"/skills"}) to browse available skills.');
        }
        const md = await resolveNode(buildUri('skills', name, 'SKILL.md'));
        const files = await nodesOfSource(skill.sourceId);
        const bundled = files.filter((f) => f.role !== 'skill_md');

        const manifest = bundled.length
          ? '\n\n## Bundled files\n' +
            bundled.map((f) => `- \`${f.path}\` (${f.role}${f.sizeBytes ? `, ${f.sizeBytes}B` : ''}) → ${f.uri}`).join('\n')
          : '\n\n_No bundled files._';

        const head = [
          `# Skill: ${skill.name}`,
          skill.description,
          skill.compatibility ? `compatibility: ${skill.compatibility}` : '',
          // The spec marks allowed-tools experimental and leaves enforcement
          // to the client. Saying so here keeps a skill from *looking* sandboxed.
          skill.allowedTools?.length
            ? `allowed-tools: ${skill.allowedTools.join(', ')} (declared by the skill; enforced by your client, not by this server)`
            : '',
          skill.license ? `license: ${skill.license}` : '',
        ].filter(Boolean).join('\n');

        // SKILL.md is stored verbatim, frontmatter included — that is what the
        // spec requires of storage. For display the frontmatter is stripped,
        // because its fields are already rendered above and repeating them
        // spends an agent's context twice on the same bytes.
        const instructions = md?.content ? stripFrontmatter(md.content) : '_SKILL.md missing._';
        // No untrusted envelope here, on purpose. A skill exists to be
        // followed: wrapping it in "treat this as data, not instructions"
        // fights the product. Documents, search hits and grep hits stay
        // enveloped; the trust boundary for skills is ingest-time validation
        // (see skill.ts) and the human who chose to `contextual add` it.
        const body = `${head}\n\n---\n\n${instructions}${manifest}`;
        const page = textPage(body, `skill:${name}`, BUDGET.skill - 256, { cursor });
        return result([
          text(page.text + continuation('cx_skill', { name }, page.nextCursor)),
          resourceLink(buildUri('skills', name, 'SKILL.md'), `${name}/SKILL.md`, skill.description, 'text/markdown'),
          ...bundled.slice(0, 20).map((f) => resourceLink(f.uri, `${name}/${f.path}`, f.role)),
        ], { next_cursor: page.nextCursor, start_character: page.start, end_character: page.end });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}

async function readChunk(uri: string, opts: { offset?: number; limit?: number; cursor?: string }) {
  const chunk = await resolveChunk(uri);
  if (!chunk) return errorResult(`No such chunk: ${uri}`);
  const neighbors = await chunkNeighbors(chunk.node.id, chunk.ord);
  const before = neighbors.filter((n) => n.ord < chunk.ord);
  const after = neighbors.filter((n) => n.ord > chunk.ord);
  const body = [
    ...before.map((n) => `…${n.content}`),
    chunk.content,
    ...after.map((n) => `${n.content}…`),
  ].join('\n\n');
  const page = textPage(body, `read:${uri}`, BUDGET.read - 256, { ...opts, untrusted: true, revision: [chunk.revision, ...neighbors.map((n) => n.revision)].join(',') });
  return result([
    text(envelope(page.text + (page.contentSuppressed && !page.nextCursor ? SUPPRESSION_NOTICE : ''), {
      uri,
      source: chunk.node.sourceName,
      heading: chunk.headingPath,
      note: 'neighbouring chunks included for context',
      content_suppressed: page.contentSuppressed,
    }) + continuation('cx_read', { uri, ...(opts.limit && { limit: opts.limit }) }, page.nextCursor)),
    resourceLink(chunk.node.uri, chunk.node.path, 'full document', 'text/markdown'),
  ], { next_cursor: page.nextCursor, start_character: page.start, end_character: page.end, content_suppressed: page.contentSuppressed });
}

async function readBlob(target: string, node: Awaited<ReturnType<typeof resolveNode>> & {}) {
  const mime = node.mimeType ?? 'application/octet-stream';
  const file = node.blobRef ? Bun.file(node.blobRef) : null;
  if (!file || !(await file.exists())) {
    return errorResult(`${target} is a binary ${mime} but its bytes are missing on disk.`, 'ASSET_MISSING', 'Re-run contextual add for its source.');
  }
  const size = file.size;
  if (size > MAX_INLINE_BLOB_BYTES) {
    return result([
      text(`${target} is a ${mime} of ${size} bytes, over the ${MAX_INLINE_BLOB_BYTES}-byte inline limit; it is not returned. It is still addressable as an MCP resource.`),
      resourceLink(target, node.path, node.role, mime),
    ], { next_cursor: null, inline: false });
  }
  const data = Buffer.from(await file.bytes()).toString('base64');
  const block: ContentBlock = /^image\/(png|jpeg|gif|webp)$/.test(mime)
    ? { type: 'image', data, mimeType: mime }
    : { type: 'resource', resource: { uri: target, mimeType: mime, blob: data } };
  return result([
    text(`${target}: ${mime}, ${size} bytes (binary, returned inline).`),
    block,
    resourceLink(target, node.path, node.role, mime),
  ], { next_cursor: null, inline: true });
}

const stripFrontmatter = (raw: string) => raw.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '').trim();

function dedupeLinks(blocks: ContentBlock[]): ContentBlock[] {
  const seen = new Set<string>();
  return blocks.filter((b) => {
    const uri = (b as { uri?: string }).uri;
    if (!uri || seen.has(uri)) return false;
    seen.add(uri);
    return true;
  });
}

function toolError(err: unknown) {
  if (err instanceof CursorError) return errorResult(err.message, err.code, 'Restart the same call without cursor.');
  if (err instanceof UriError || err instanceof InputError) return errorResult(`Rejected: ${err.message}`, 'INVALID_ARGUMENT', 'Correct the arguments using the tool schema and cx_ls paths.');
  // A cancelled query is a budget the caller can act on, not a server fault,
  // so it is returned as its own advice rather than logged as an internal error.
  if (err instanceof GrepTooExpensiveError || err instanceof SearchTooExpensiveError) {
    return errorResult(`Too expensive: ${err.message}`, 'QUERY_TIMEOUT', err.message);
  }
  log('tool error:', err);
  if ([UNDEFINED_TABLE, UNDEFINED_COLUMN].includes(sqlState(err) ?? '')) {
    return errorResult('The database schema is not up to date.', 'MIGRATIONS_REQUIRED', 'Run contextual migrate against the server database.');
  }
  return errorResult('contextual could not complete the request.', 'SERVICE_ERROR', 'Run contextual doctor and check the server logs before retrying.', true);
}

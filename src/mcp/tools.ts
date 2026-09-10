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
import { listPath, renderListing } from '../core/vfs/list';
import { glob } from '../core/vfs/glob';
import { grep, GrepTooExpensiveError } from '../core/vfs/grep';
import { search, SearchTooExpensiveError } from '../core/search/hybrid';
import { resolveNode, resolveChunk, chunkNeighbors, skillByName, nodesOfSource } from '../core/vfs/resolve';
import { INDEX_URI, parseUri, pathToUri, buildUri, UriError } from '../core/vfs/uri';
import { BUDGET, MAX_INLINE_BLOB_BYTES, cap, envelope, errorResult, resourceLink, result, text, log } from './format';

export function registerTools(server: McpServer): void {
  server.registerTool(
    'cx_ls',
    {
      title: 'List the context filesystem',
      description:
        'List what is available. Start here: cx_ls("/") is the level-0 catalog — every skill and ' +
        'document collection, cheap enough to read on every session. Then descend: "/skills", ' +
        '"/skills/{name}", "/docs/{collection}".',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: { path: z.string().default('/').describe('VFS directory path'), offset: z.number().int().min(0).default(0) },
    },
    async ({ path, offset }) => {
      try {
        // The root listing is the catalog itself, not a two-line directory:
        // one call has to tell an agent everything that exists.
        if (!path || path === '/') {
          const body = renderCatalog(await loadCatalog());
          return result([text(cap(body, BUDGET.index).text), resourceLink('ctx://index', 'contextual catalog', 'Level-0 catalog', 'text/markdown')]);
        }
        const listing = await listPath(path, { offset });
        const blocks: ContentBlock[] = [text(cap(renderListing(listing), BUDGET.ls, `Narrow the path or use cx_glob.`).text)];
        for (const e of listing.entries.filter((x) => x.uri).slice(0, 25)) {
          blocks.push(resourceLink(e.uri!, e.name, e.note, 'text/markdown'));
        }
        return result(blocks);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'cx_glob',
    {
      title: 'Find files by path pattern',
      description:
        'Find files by glob against their full VFS path. "**/*.py" finds every script; ' +
        '"/skills/pdf/**" finds one bundle\'s files. Returns paths only — use cx_read to open one.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        pattern: z.string().describe('Glob, e.g. "**/*.md", "/skills/*/references/**"'),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ pattern, limit }) => {
      try {
        const hits = await glob(pattern, limit);
        if (!hits.length) return result(`No files match ${pattern}.`);
        const body = hits.map((h) => `${h.path}  (${h.role}${h.sizeBytes ? `, ${h.sizeBytes}B` : ''})`).join('\n');
        return result([
          text(cap(`${hits.length} match${hits.length === 1 ? '' : 'es'}:\n${body}`, BUDGET.glob, 'Narrow the pattern.').text),
          ...hits.slice(0, 20).map((h) => resourceLink(h.uri, h.path, h.role)),
        ]);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'cx_grep',
    {
      title: 'Search file contents for an exact pattern',
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
      },
    },
    async ({ pattern, path_glob, ignore_case, limit }) => {
      try {
        const matches = await grep(pattern, { pathGlob: path_glob, ignoreCase: ignore_case, maxMatches: limit });
        if (!matches.length) {
          return result(
            `No matches for /${pattern}/${path_glob ? ` under ${path_glob}` : ''}.` +
              (path_glob ? ' Paths are VFS paths, as shown by cx_ls — e.g. "/skills/{name}/**".' : ''),
          );
        }
        const body = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n');
        // Matching lines are document content, so they are framed as data for
        // the same reason cx_read and cx_search are: a line lifted out of an
        // uploaded PDF is not an instruction.
        return result([
          text(envelope(
            cap(`${matches.length} match${matches.length === 1 ? '' : 'es'}:\n${body}`, BUDGET.grep, 'Narrow with path_glob or a tighter pattern.').text,
            { pattern, matches: matches.length, ...(path_glob && { path_glob }) },
          )),
          ...dedupeLinks(matches.map((m) => resourceLink(m.uri, m.path))).slice(0, 20),
        ]);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'cx_read',
    {
      title: 'Read one file or chunk',
      description:
        'Read a single file by ctx:// URI or VFS path. This is the deepest level — read only what ' +
        'cx_ls, cx_search or cx_skill pointed you at. A chunk URI (…#chunk=N) returns that passage ' +
        'plus its neighbours. Long files are truncated with an offset to continue from.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        uri: z.string().describe('ctx:// URI or VFS path, e.g. "ctx://skills/pdf/SKILL.md" or "/skills/pdf/SKILL.md"'),
        offset: z.number().int().min(0).default(0).describe('Line to start from, for continuing a truncated read'),
        limit: z.number().int().min(1).max(5000).optional().describe('Maximum lines to return'),
      },
    },
    async ({ uri, offset, limit }) => {
      try {
        const target = uri.startsWith('ctx://') ? uri : pathToUri(uri);
        if (!target) return errorResult(`Not a readable path: ${uri}. Use cx_ls("/") to see what exists.`);

        if (target === INDEX_URI) return result(renderCatalog(await loadCatalog()));
        const parsed = parseUri(target);
        if (parsed.chunk !== undefined) return await readChunk(target);

        const node = await resolveNode(target);
        if (!node) return errorResult(`No such resource: ${target}. Use cx_ls to find the right path.`);

        // A binary asset is returned inline — as an image block when it is
        // one, otherwise as an embedded resource — because Resources are
        // host-driven and an agent cannot fetch them on its own. Sending the
        // model to `resources/read` would make every logo and screenshot a
        // dead end on the only surface it can actually use.
        if (node.content === null) return await readBlob(target, node);

        const lines = node.content.split('\n');
        const slice = lines.slice(offset, limit ? offset + limit : undefined);
        const capped = cap(slice.join('\n'), BUDGET.read, `Continue with cx_read(uri, offset=${offset + estimateLines(slice, BUDGET.read)}).`);
        const meta = { uri: target, source: node.sourceName, role: node.role, lines: `${offset + 1}-${offset + slice.length} of ${lines.length}` };
        // The trust split is by *content kind*, not by which tool was called.
        // A SKILL.md is instructions whether it arrives via cx_skill or via a
        // resource_link followed with cx_read; wrapping it here in "do not
        // follow this" would make the same bytes mean two different things.
        const body = node.role === 'skill_md'
          ? `${Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${capped.text}`
          : envelope(capped.text, meta);
        return result([
          text(body),
          resourceLink(target, node.path, node.role, node.mimeType ?? 'text/plain'),
        ]);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'cx_search',
    {
      title: 'Search documents and skills for relevant passages',
      description:
        'Ranked hybrid search (full-text + semantic) over every ingested document and skill ' +
        'reference. Pass ALL parts of a multi-part question as an array in one call — results are ' +
        'merged and re-ranked together. Returns snippets with citable ctx:// links; follow one with ' +
        'cx_read to see the full passage.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        queries: z.array(z.string()).min(1).max(8).describe('One or more natural-language queries'),
        scope: z.string().optional().describe('Restrict to "skills", "docs", or "docs/{collection}"'),
        limit: z.number().int().min(1).max(25).default(8),
      },
    },
    async ({ queries, scope, limit }) => {
      try {
        const hits = await search(queries, { limit, scope });
        if (!hits.length) {
          return result(
            `No passages found for ${queries.map((q) => JSON.stringify(q)).join(', ')}` +
              `${scope ? ` in ${scope}` : ''}. Try cx_ls("/") to see what is ingested, or broaden the wording.`,
          );
        }
        const body = hits
          .map((h, i) => {
            const where = h.headingPath?.length ? ` › ${h.headingPath.join(' › ')}` : '';
            return `${i + 1}. ${h.path}${where}\n   ${h.snippet.replace(/\s+/g, ' ').trim()}\n   ${h.uri}`;
          })
          .join('\n\n');
        return result([
          text(envelope(cap(body, BUDGET.search, 'Read a specific hit with cx_read.').text, { queries: queries.join(' | '), hits: hits.length })),
          ...hits.map((h) => resourceLink(h.uri, `${h.sourceName}${h.headingPath?.length ? ` › ${h.headingPath.at(-1)}` : ''}`, h.snippet.replace(/\*\*/g, '').slice(0, 160), 'text/markdown')),
        ]);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'cx_skill',
    {
      title: 'Load an Agent Skill',
      description:
        "Load one skill's full instructions (SKILL.md, verbatim) plus a manifest of its bundled " +
        'references, scripts and assets. Read the manifest, then cx_read only the files the task ' +
        'needs. Bundled scripts are never executed by this server — run them in your own sandbox.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: { name: z.string().describe('Skill name, as shown by cx_ls("/skills")') },
    },
    async ({ name }) => {
      try {
        const skill = await skillByName(name);
        if (!skill) {
          const listing = await listPath('/skills');
          return errorResult(`No skill named "${name}". Available:\n${cap(renderListing(listing), BUDGET.ls, 'Use cx_ls("/skills") to browse.').text}`);
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
        return result([
          text(cap(body, BUDGET.skill, `Read individual files with cx_read.`).text),
          resourceLink(buildUri('skills', name, 'SKILL.md'), `${name}/SKILL.md`, skill.description, 'text/markdown'),
          ...bundled.slice(0, 20).map((f) => resourceLink(f.uri, `${name}/${f.path}`, f.role)),
        ]);
      } catch (err) {
        return toolError(err);
      }
    },
  );
}

async function readChunk(uri: string) {
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
  return result([
    text(envelope(cap(body, BUDGET.read, `Read the whole document with cx_read("${chunk.node.uri}").`).text, {
      uri,
      source: chunk.node.sourceName,
      heading: chunk.headingPath,
      note: 'neighbouring chunks included for context',
    })),
    resourceLink(chunk.node.uri, chunk.node.path, 'full document', 'text/markdown'),
  ]);
}

async function readBlob(target: string, node: Awaited<ReturnType<typeof resolveNode>> & {}) {
  const mime = node.mimeType ?? 'application/octet-stream';
  const file = node.blobRef ? Bun.file(node.blobRef) : null;
  if (!file || !(await file.exists())) {
    return errorResult(`${target} is a binary ${mime} but its bytes are missing on disk; re-run \`contextual add\` for its source.`);
  }
  const size = file.size;
  if (size > MAX_INLINE_BLOB_BYTES) {
    return result([
      text(`${target} is a ${mime} of ${size} bytes, over the ${MAX_INLINE_BLOB_BYTES}-byte inline limit; it is not returned. It is still addressable as an MCP resource.`),
      resourceLink(target, node.path, node.role, mime),
    ]);
  }
  const data = Buffer.from(await file.bytes()).toString('base64');
  const block: ContentBlock = /^image\/(png|jpeg|gif|webp)$/.test(mime)
    ? { type: 'image', data, mimeType: mime }
    : { type: 'resource', resource: { uri: target, mimeType: mime, blob: data } };
  return result([
    text(`${target}: ${mime}, ${size} bytes (binary, returned inline).`),
    block,
    resourceLink(target, node.path, node.role, mime),
  ]);
}

const stripFrontmatter = (raw: string) => raw.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '').trim();

const estimateLines = (lines: string[], budgetTokens: number) => {
  let chars = 0;
  for (let i = 0; i < lines.length; i++) {
    chars += lines[i]!.length + 1;
    if (chars > budgetTokens * 4) return i;
  }
  return lines.length;
};

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
  if (err instanceof UriError) return errorResult(`Rejected: ${err.message}`);
  // A cancelled query is a budget the caller can act on, not a server fault,
  // so it is returned as its own advice rather than logged as an internal error.
  if (err instanceof GrepTooExpensiveError || err instanceof SearchTooExpensiveError) {
    return errorResult(`Too expensive: ${err.message}`);
  }
  log('tool error:', err);
  return errorResult(`contextual: ${(err as Error).message ?? String(err)}`);
}

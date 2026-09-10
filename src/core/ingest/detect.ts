/**
 * What did the user just hand us?
 *
 * A `SKILL.md` at the root of a directory (or a zip) means an Agent Skill
 * bundle; other files require a supported document format or valid text. The check is deliberately narrow —
 * "root" means root, because a repository that merely *contains* skills is not
 * itself a skill, and treating it as one would store an arbitrary tree as
 * procedural instructions.
 */
import { lstat, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { formatFromBytes, formatFromPath } from '@firecrawl/anydoc';

export type InputKind = 'skill' | 'document' | 'html' | 'directory-of-sources';

export interface Detection {
  kind: InputKind;
  path: string;
  /** For a skill: the bundle root. For a document: the file. */
  root: string;
  /** anydoc's format name, when it recognized one. */
  format?: string;
  /** Members of a directory that is not itself a skill bundle. */
  members?: string[];
  reason: string;
}

const HTML_EXT = new Set(['.html', '.htm', '.xhtml']);
/** Never worth walking as "a directory of sources"; hidden entries are skipped too. */
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', 'target', 'dist', 'build']);
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.text', '.rst', '.json', '.yaml', '.yml']);

export async function detect(path: string): Promise<Detection> {
  const st = await lstat(path);

  if (st.isSymbolicLink()) throw new Error(`${path}: symlinks are not ingested`);
  if (!st.isDirectory() && !st.isFile()) throw new Error(`${path}: not a regular file`);

  if (st.isDirectory()) {
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.some((e) => e.name === 'SKILL.md' && e.isFile())) {
      return { kind: 'skill', path, root: path, reason: 'SKILL.md at bundle root' };
    }
    // A directory of documents, or a directory of skill bundles — the caller
    // walks it and re-detects each member.
    const members = await Promise.all(
      entries.filter((e) => !e.name.startsWith('.') && !SKIP_DIRS.has(e.name) && (e.isFile() || e.isDirectory())).sort((a, b) => a.name.localeCompare(b.name)).map(async (e) => join(path, e.name)),
    );
    return { kind: 'directory-of-sources', path, root: path, members, reason: 'directory without a root SKILL.md' };
  }

  const ext = extname(path).toLowerCase();

  if (ext === '.zip' || ext === '.skill') {
    // A zipped bundle is still a bundle; the pipeline expands it before
    // re-detecting, so the SKILL.md-at-root rule applies to its contents.
    return { kind: 'skill', path, root: path, reason: 'zip archive — expanded and re-detected' };
  }

  // Format comes from the bytes, not the extension: uploads are exactly where
  // extensions lie. A mislabeled .txt that is really a PDF still converts.
  const head = await readHead(path);
  const byBytes = formatFromBytes(head);
  if (byBytes) return { kind: 'document', path, root: path, format: byBytes, reason: `signature identifies ${byBytes}` };

  if (HTML_EXT.has(ext)) {
    return { kind: 'html', path, root: path, reason: 'HTML is not an anydoc format; routed to readability + turndown' };
  }

  // Signature-less formats (CSV, plain text) fall back to the extension.
  const byExt = formatFromPath(path);
  if (byExt) return { kind: 'document', path, root: path, format: byExt, reason: `extension identifies ${byExt}` };

  if (TEXT_EXT.has(ext) || (await looksLikeText(head))) {
    return { kind: 'document', path, root: path, format: 'text', reason: 'plain text, ingested as-is' };
  }

  return { kind: 'document', path, root: path, reason: `unrecognized format for ${basename(path)}` };
}

async function readHead(path: string, bytes = 4096): Promise<Uint8Array> {
  const file = Bun.file(path);
  return new Uint8Array(await file.slice(0, Math.min(bytes, file.size)).arrayBuffer());
}

/** No NUL bytes and mostly-printable is a good enough proxy for "text". */
async function looksLikeText(head: Uint8Array): Promise<boolean> {
  if (head.length === 0) return true;
  if (head.includes(0)) return false;
  let printable = 0;
  for (const b of head) if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128) printable++;
  return printable / head.length > 0.9;
}

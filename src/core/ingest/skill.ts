/**
 * Agent Skill ingestion: parse, validate against the published frontmatter
 * spec, and store the bundle tree verbatim.
 *
 * Verbatim matters. `SKILL.md` is authored to be read whole by a model — its
 * structure *is* the progressive disclosure — so it is never chunked and never
 * reformatted. Reference files are a different matter: they are reference
 * material, so they get chunked and embedded for search.
 *
 * Validation is strict rather than forgiving because a skill becomes
 * *instructions* in an agent's context. A bundle that does not meet the spec
 * is rejected loudly at ingest, where a human is watching.
 */
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep, extname } from 'node:path';

import { decodeText } from './text';

export const RESERVED_WORDS = ['anthropic', 'claude'];
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;
export const COMPATIBILITY_MAX = 500;
export const ALLOWED_KEYS = new Set(['name', 'description', 'allowed-tools', 'compatibility', 'license', 'metadata']);

export interface SkillFrontmatter {
  name: string;
  description: string;
  allowedTools?: string[];
  /** Free-text environment requirements (intended product, packages, network). */
  compatibility?: string;
  license?: string;
  metadata?: Record<string, unknown>;
}

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  /** SKILL.md exactly as authored, frontmatter included. */
  raw: string;
  /** The instruction body, frontmatter removed. */
  body: string;
}

export class SkillValidationError extends Error {
  constructor(message: string, readonly issues: string[] = []) {
    super(message);
  }
}

/** An XML tag anywhere in name or description is prompt-injection surface. */
const XML_TAG = /<\/?[a-zA-Z][^>]*>/;
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface ValidateOptions {
  /**
   * The spec reserves "anthropic" and "claude" in skill names so third-party
   * skills cannot impersonate first-party ones. Anthropic's own published
   * bundles are exempt from it — `anthropics/skills` ships `claude-api` — so a
   * blanket rejection makes real, publisher-authored bundles un-ingestable.
   * Default is spec-conformant; the flag exists for exactly that case.
   */
  allowReservedNames?: boolean;
  lenient?: boolean;
  onWarning?: (message: string) => void;
}

export function parseSkillMd(raw: string, opts: ValidateOptions = {}): ParsedSkill {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!m) throw new SkillValidationError('SKILL.md has no YAML frontmatter block (expected a leading `---` fence)');

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(m[1]!);
  } catch (err) {
    throw new SkillValidationError(`SKILL.md frontmatter is not valid YAML: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SkillValidationError('SKILL.md frontmatter must be a YAML mapping');
  }

  return {
    frontmatter: validateFrontmatter(parsed as Record<string, unknown>, opts),
    raw,
    body: raw.slice(m[0].length).trim(),
  };
}

export function validateFrontmatter(fm: Record<string, unknown>, opts: ValidateOptions = {}): SkillFrontmatter {
  const issues: string[] = [];

  for (const key of Object.keys(fm)) {
    if (!ALLOWED_KEYS.has(key) && opts.lenient) opts.onWarning?.(`Ignoring unknown frontmatter key "${key}"`);
    if (!ALLOWED_KEYS.has(key) && !opts.lenient) issues.push(`unknown frontmatter key "${key}" (allowed: ${[...ALLOWED_KEYS].join(', ')})`);
  }

  const name = fm.name;
  if (typeof name !== 'string' || name.trim() === '') issues.push('name is required and must be a non-empty string');
  else {
    if (name.length > NAME_MAX) issues.push(`name is ${name.length} characters; the limit is ${NAME_MAX}`);
    if (XML_TAG.test(name)) issues.push('name must not contain XML tags');
    if (!NAME_RE.test(name)) issues.push(`name "${name}" must be lowercase letters, digits and single hyphens only`);
    // Reserved words are matched as whole hyphen-delimited segments: a skill
    // called "claude-code-helper" is reserved, but "unclaimed" is not.
    if (!opts.allowReservedNames) {
      for (const word of RESERVED_WORDS) {
        if (name.toLowerCase().split('-').includes(word)) {
          issues.push(
            `name must not contain the reserved word "${word}". If this bundle is genuinely ` +
              `first-party (anthropics/skills ships \`claude-api\`), re-run with --allow-reserved.`,
          );
        }
      }
    }
  }

  const description = fm.description;
  if (typeof description !== 'string' || description.trim() === '') issues.push('description is required and must be a non-empty string');
  else {
    if (description.length > DESCRIPTION_MAX) issues.push(`description is ${description.length} characters; the limit is ${DESCRIPTION_MAX}`);
    if (XML_TAG.test(description)) issues.push('description must not contain XML tags');
  }

  const allowedRaw = fm['allowed-tools'];
  let allowedTools: string[] | undefined;
  if (allowedRaw !== undefined) {
    if (Array.isArray(allowedRaw) && allowedRaw.every((t) => typeof t === 'string')) allowedTools = allowedRaw as string[];
    // The published examples use a comma-separated string as well as a list.
    else if (typeof allowedRaw === 'string') allowedTools = tokenizeAllowedTools(allowedRaw);
    else issues.push('allowed-tools must be a list of strings or a comma-separated string');
  }

  const compatRaw = fm.compatibility;
  let compatibility: string | undefined;
  if (compatRaw !== undefined) {
    // The spec defines this as a string, and a hosted or multi-runtime agent
    // reads it to learn that a skill needs a binary or network access that
    // this machine may not have. It is rendered into an agent's context, so
    // it gets the same XML-tag rule as name and description.
    if (typeof compatRaw !== 'string') issues.push('compatibility must be a string');
    else {
      if (compatRaw.length > COMPATIBILITY_MAX) issues.push(`compatibility is ${compatRaw.length} characters; the limit is ${COMPATIBILITY_MAX}`);
      if (XML_TAG.test(compatRaw)) issues.push('compatibility must not contain XML tags');
      compatibility = compatRaw.trim();
    }
  }

  if (fm.license !== undefined && typeof fm.license !== 'string') issues.push('license must be a string');
  if (fm.metadata !== undefined && (typeof fm.metadata !== 'object' || fm.metadata === null || Array.isArray(fm.metadata))) {
    issues.push('metadata must be a mapping');
  }

  if (issues.length) throw new SkillValidationError(`invalid SKILL.md frontmatter:\n  - ${issues.join('\n  - ')}`, issues);

  return {
    name: (name as string).trim(),
    description: (description as string).trim(),
    allowedTools,
    compatibility,
    license: fm.license as string | undefined,
    metadata: fm.metadata as Record<string, unknown> | undefined,
  };
}

export type SkillFileRole = 'skill_md' | 'reference' | 'script' | 'asset';

export interface SkillFile {
  /** Bundle-relative, always forward-slashed. */
  path: string;
  absPath: string;
  role: SkillFileRole;
  size: number;
  mimeType: string;
  isText: boolean;
}

const SCRIPT_EXT = new Set(['.py', '.sh', '.bash', '.zsh', '.js', '.ts', '.mjs', '.rb', '.pl', '.ps1']);
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv', '.xml', '.html', '.rst', '.toml', '.ini', '.cfg', ...SCRIPT_EXT]);
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', '.DS_Store']);

/**
 * A directory bundle gets the same caps a zipped one does. `contextual add .`
 * on a repository that happens to have a `SKILL.md` at its root would
 * otherwise ingest the whole tree, and a bundle is not a backup tool.
 */
export const MAX_BUNDLE_FILES = 2000;
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
export const MAX_BUNDLE_DEPTH = 16;

export class BundleTooLargeError extends SkillValidationError {}

/**
 * Walks a bundle, classifying every file by the convention the skill format
 * uses, under the same caps a zipped bundle gets.
 *
 * Dotfiles are skipped everywhere, not just at the root. A bundle has no use
 * for `.env`, `.git/config` or `.npmrc`, and ingesting one publishes its
 * contents to every agent that can call `cx_read` — the exact secret-leak
 * shape that makes `contextual add .` dangerous. Symlinks are skipped too:
 * `withFileTypes` reports them as neither file nor directory, so a link
 * pointing outside the bundle is never followed.
 */
export async function walkBundle(root: string): Promise<SkillFile[]> {
  const out: SkillFile[] = [];
  let bytes = 0;

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > MAX_BUNDLE_DEPTH) {
      throw new BundleTooLargeError(`bundle nests deeper than ${MAX_BUNDLE_DEPTH} directories at ${relative(root, dir) || '.'}`);
    }
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      // A dotfile is never bundle content; `.DS_Store` is covered by this too.
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) { await visit(abs, depth + 1); continue; }
      // Not a regular file: a symlink, socket or device. Never followed.
      if (!entry.isFile()) continue;

      const rel = relative(root, abs).split(sep).join('/');
      const size = (await stat(abs)).size;

      bytes += size;
      if (out.length >= MAX_BUNDLE_FILES) {
        throw new BundleTooLargeError(`bundle has more than ${MAX_BUNDLE_FILES} files; point at the bundle directory, not its parent`);
      }
      if (bytes > MAX_BUNDLE_BYTES) {
        throw new BundleTooLargeError(`bundle is larger than ${MAX_BUNDLE_BYTES} bytes; point at the bundle directory, not its parent`);
      }

      const ext = extname(rel).toLowerCase();
      let isText = false;
      try { decodeText(await Bun.file(abs).bytes()); isText = !mimeFor(ext).startsWith('image/'); } catch { /* opaque asset */ }
      out.push({
        path: rel,
        absPath: abs,
        role: isText && !ext && !rel.startsWith('assets/') ? 'reference' : classify(rel, ext),
        size,
        mimeType: isText && !ext ? 'text/plain' : mimeFor(ext),
        isText,
      });
    }
  }

  await visit(root, 0);
  return out.sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)));
}

function classify(rel: string, ext: string): SkillFileRole {
  if (rel === 'SKILL.md') return 'skill_md';
  const top = rel.split('/')[0];
  if (top === 'scripts') return 'script';
  if (top === 'references') return 'reference';
  if (top === 'assets') return 'asset';
  // Outside the conventional directories, the extension decides.
  if (SCRIPT_EXT.has(ext)) return 'script';
  return TEXT_EXT.has(ext) ? 'reference' : 'asset';
}

function mimeFor(ext: string): string {
  const map: Record<string, string> = {
    '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain',
    '.json': 'application/json', '.yaml': 'text/yaml', '.yml': 'text/yaml',
    '.csv': 'text/csv', '.xml': 'application/xml', '.html': 'text/html',
    '.py': 'text/x-python', '.sh': 'text/x-shellscript', '.bash': 'text/x-shellscript',
    '.js': 'text/javascript', '.ts': 'text/typescript', '.rb': 'text/x-ruby',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.zip': 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** Commas and whitespace delimit tools except inside permission parentheses. */
export function tokenizeAllowedTools(value: string): string[] {
  const out: string[] = [];
  let token = '', depth = 0;
  for (const char of value) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (depth < 0) throw new SkillValidationError('unbalanced allowed-tools parentheses');
    if (depth === 0 && /[\s,]/.test(char)) {
      if (token) out.push(token);
      token = '';
    } else token += char;
  }
  if (depth) throw new SkillValidationError('unbalanced allowed-tools parentheses');
  if (token) out.push(token);
  return out;
}

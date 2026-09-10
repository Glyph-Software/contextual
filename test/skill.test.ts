import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSkillMd, validateFrontmatter, SkillValidationError, walkBundle,
  BundleTooLargeError, MAX_BUNDLE_FILES, NAME_MAX, DESCRIPTION_MAX,
} from '../src/core/ingest/skill';

const fm = (over: Record<string, unknown> = {}) => ({ name: 'my-skill', description: 'Does a thing. Use when a thing must be done.', ...over });
const issuesOf = (fn: () => unknown): string[] => {
  try { fn(); return []; } catch (e) { return (e as SkillValidationError).issues; }
};

describe('frontmatter: name', () => {
  test('accepts lowercase, digits and single hyphens', () => {
    expect(validateFrontmatter(fm({ name: 'pdf-2-markdown' })).name).toBe('pdf-2-markdown');
  });

  test.each([
    ['My-Skill', 'uppercase'],
    ['my_skill', 'underscore'],
    ['my skill', 'space'],
    ['my--skill', 'double hyphen'],
    ['-leading', 'leading hyphen'],
    ['trailing-', 'trailing hyphen'],
    ['pdf.tools', 'dot'],
  ])('rejects %s (%s)', (name) => {
    expect(issuesOf(() => validateFrontmatter(fm({ name }))).join()).toContain('lowercase');
  });

  test(`rejects a name over ${NAME_MAX} characters, accepts exactly ${NAME_MAX}`, () => {
    const at = 'a'.repeat(NAME_MAX);
    expect(validateFrontmatter(fm({ name: at })).name).toHaveLength(NAME_MAX);
    expect(issuesOf(() => validateFrontmatter(fm({ name: 'a'.repeat(NAME_MAX + 1) }))).join()).toContain(`limit is ${NAME_MAX}`);
  });

  test('rejects XML tags', () => {
    // Name is checked before the character-class rule would also catch it, so
    // the author is told the actual reason.
    expect(issuesOf(() => validateFrontmatter(fm({ name: '<script>x</script>' }))).join()).toContain('XML tags');
  });

  test.each(['claude', 'anthropic'])('rejects the reserved word %s as a segment', (word) => {
    expect(issuesOf(() => validateFrontmatter(fm({ name: `${word}-api` }))).join()).toContain(`reserved word "${word}"`);
    expect(issuesOf(() => validateFrontmatter(fm({ name: `my-${word}` }))).join()).toContain(`reserved word "${word}"`);
  });

  test('does not reject a word that merely contains a reserved word', () => {
    // "unclaimed" contains "claim", not "claude"; "anthropology" is not "anthropic".
    expect(validateFrontmatter(fm({ name: 'anthropology-helper' })).name).toBe('anthropology-helper');
  });

  test('allowReservedNames lets a genuinely first-party bundle through', () => {
    expect(validateFrontmatter(fm({ name: 'claude-api' }), { allowReservedNames: true }).name).toBe('claude-api');
  });

  test('requires a name', () => {
    expect(issuesOf(() => validateFrontmatter({ description: 'x' })).join()).toContain('name is required');
  });
});

describe('frontmatter: description', () => {
  test(`accepts exactly ${DESCRIPTION_MAX}, rejects one more`, () => {
    expect(validateFrontmatter(fm({ description: 'd'.repeat(DESCRIPTION_MAX) })).description).toHaveLength(DESCRIPTION_MAX);
    expect(issuesOf(() => validateFrontmatter(fm({ description: 'd'.repeat(DESCRIPTION_MAX + 1) }))).join()).toContain(`limit is ${DESCRIPTION_MAX}`);
  });

  test('rejects empty, whitespace-only, and XML tags', () => {
    expect(issuesOf(() => validateFrontmatter(fm({ description: '' }))).join()).toContain('description is required');
    expect(issuesOf(() => validateFrontmatter(fm({ description: '   ' }))).join()).toContain('description is required');
    expect(issuesOf(() => validateFrontmatter(fm({ description: 'see <thinking> block' }))).join()).toContain('XML tags');
  });

  test('allows angle brackets that are not tags', () => {
    expect(validateFrontmatter(fm({ description: 'Use when latency < 5ms or n > 100.' })).description).toContain('<');
  });
});

describe('frontmatter: other keys', () => {
  test('rejects unknown keys', () => {
    expect(issuesOf(() => validateFrontmatter(fm({ author: 'me' }))).join()).toContain('unknown frontmatter key "author"');
  });

  test('keeps compatibility as a bounded string', () => {
    expect(validateFrontmatter(fm({ compatibility: 'Needs docker and network access. ' })).compatibility)
      .toBe('Needs docker and network access.');
    expect(issuesOf(() => validateFrontmatter(fm({ compatibility: { network: true } }))).join()).toContain('compatibility must be a string');
    expect(issuesOf(() => validateFrontmatter(fm({ compatibility: 'x'.repeat(501) }))).join()).toContain('limit is 500');
    expect(issuesOf(() => validateFrontmatter(fm({ compatibility: 'needs <b>docker</b>' }))).join()).toContain('XML tags');
  });

  test('accepts allowed-tools as a list or a comma-separated string', () => {
    expect(validateFrontmatter(fm({ 'allowed-tools': ['Read', 'Bash'] })).allowedTools).toEqual(['Read', 'Bash']);
    expect(validateFrontmatter(fm({ 'allowed-tools': 'Read, Bash' })).allowedTools).toEqual(['Read', 'Bash']);
  });

  test('rejects a non-mapping metadata', () => {
    expect(issuesOf(() => validateFrontmatter(fm({ metadata: ['a'] }))).join()).toContain('metadata must be a mapping');
  });

  test('reports every problem at once, not just the first', () => {
    const issues = issuesOf(() => validateFrontmatter({ name: 'BAD NAME', description: '', extra: 1 }));
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('parseSkillMd', () => {
  test('separates frontmatter from body', () => {
    const p = parseSkillMd('---\nname: a-skill\ndescription: Does a thing.\n---\n\n# Heading\n\nBody.\n');
    expect(p.frontmatter.name).toBe('a-skill');
    expect(p.body).toBe('# Heading\n\nBody.');
    expect(p.raw).toContain('---');
  });

  test('tolerates CRLF and a BOM', () => {
    const p = parseSkillMd('﻿---\r\nname: a-skill\r\ndescription: Does a thing.\r\n---\r\nBody.\r\n');
    expect(p.frontmatter.name).toBe('a-skill');
  });

  test('rejects a file with no frontmatter', () => {
    expect(() => parseSkillMd('# Just markdown\n')).toThrow(/no YAML frontmatter/);
  });

  test('rejects frontmatter that is not a mapping', () => {
    expect(() => parseSkillMd('---\n- a\n- b\n---\n')).toThrow(/must be a YAML mapping/);
  });

  test('rejects invalid YAML', () => {
    expect(() => parseSkillMd('---\nname: "unclosed\n---\n')).toThrow(SkillValidationError);
  });
});


describe('walkBundle guards', () => {
  const bundles: string[] = [];
  const make = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'contextual-walk-'));
    bundles.push(dir);
    await writeFile(join(dir, 'SKILL.md'), '---\nname: walker\ndescription: Walks.\n---\n\n# Walker\n');
    return dir;
  };
  afterAll(async () => { for (const d of bundles) await rm(d, { recursive: true, force: true }); });

  test('skips dotfiles anywhere in the tree, not just at the root', async () => {
    const dir = await make();
    // A bundle has no use for these, and ingesting one publishes it to every
    // agent that can call cx_read.
    await writeFile(join(dir, '.env'), 'AWS_SECRET_ACCESS_KEY=hunter2\n');
    await mkdir(join(dir, 'references'), { recursive: true });
    await writeFile(join(dir, 'references', '.npmrc'), '//registry:_authToken=secret\n');
    await writeFile(join(dir, 'references', 'ok.md'), '# Fine\n');

    const paths = (await walkBundle(dir)).map((f) => f.path);
    expect(paths).toEqual(['SKILL.md', 'references/ok.md']);
  });

  test('does not follow a symlink out of the bundle', async () => {
    const dir = await make();
    await symlink('/etc/passwd', join(dir, 'passwd'));
    expect((await walkBundle(dir)).map((f) => f.path)).toEqual(['SKILL.md']);
  });

  test('refuses a tree with more files than a bundle should have', async () => {
    const dir = await make();
    await mkdir(join(dir, 'references'), { recursive: true });
    await Promise.all(
      Array.from({ length: MAX_BUNDLE_FILES + 2 }, (_, i) =>
        writeFile(join(dir, 'references', `f-${i}.md`), `# ${i}\n`)),
    );
    expect(walkBundle(dir)).rejects.toThrow(BundleTooLargeError);
    expect(walkBundle(dir)).rejects.toThrow(/more than \d+ files/);
  }, 30_000);
});

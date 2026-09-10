import { NUMERIC_SETTINGS } from '../src/core/config';
const path = new URL('../README.md', import.meta.url);
const text = await Bun.file(path).text();
const rows = Object.entries(NUMERIC_SETTINGS).map(([name, [value, min, max]]) => `| \`${name}\` | ${value}; allowed ${min}–${max} |`).join('\n');
const next = text.replace(/<!-- numeric-settings:start -->[\s\S]*?<!-- numeric-settings:end -->/, `<!-- numeric-settings:start -->\n${rows}\n<!-- numeric-settings:end -->`);
if (process.argv.includes('--check')) {
  if (next !== text) throw new Error('README numeric settings are stale; run bun run scripts/config-docs.ts');
} else await Bun.write(path, next);

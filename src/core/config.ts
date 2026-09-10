/** Validated environment settings, shared by runtime, help, and documentation. */
export const NUMERIC_SETTINGS = {
  CONTEXTUAL_SEARCH_TIMEOUT_MS: [10000, 1, 3600000, true],
  CONTEXTUAL_GREP_TIMEOUT_MS: [5000, 1, 3600000, true],
  CONTEXTUAL_MAX_DISTANCE: [1, 0, 2, false],
  CONTEXTUAL_BULK_INDEX_THRESHOLD: [2000, 0, 1000000000, true],
  CONTEXTUAL_MAX_RESOURCE_BLOB_BYTES: [12582912, 1, 1073741824, true],
  CONTEXTUAL_RESOURCE_PAGE: [100, 1, 1000, true],
  CONTEXTUAL_WATCH_MS: [3000, 50, 3600000, true],
  CONTEXTUAL_VOYAGE_TIMEOUT_MS: [30000, 1, 3600000, true],
  CONTEXTUAL_VOYAGE_MAX_ATTEMPTS: [6, 1, 10, true],
  CONTEXTUAL_VOYAGE_RETRY_MAX_MS: [120000, 1, 3600000, true],
} as const;
export function envNumber(name: keyof typeof NUMERIC_SETTINGS): number {
  const [fallback, min, max, integer] = NUMERIC_SETTINGS[name];
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!raw.trim() || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return value;
}
export function validateConfig(): void {
  for (const key of Object.keys(NUMERIC_SETTINGS)) envNumber(key as keyof typeof NUMERIC_SETTINGS);
  if (process.env.CONTEXTUAL_OCR && !['hosted', 'reject'].includes(process.env.CONTEXTUAL_OCR)) throw new Error('CONTEXTUAL_OCR must be hosted or reject');
  if (process.env.CONTEXTUAL_RERANK && !['true', 'false'].includes(process.env.CONTEXTUAL_RERANK)) throw new Error('CONTEXTUAL_RERANK must be true or false');
}
export function configHelp(): string {
  return Object.entries(NUMERIC_SETTINGS).map(([key, [value]]) => `  ${key.padEnd(37)} default: ${value}`).join('\n');
}
export function databaseHint(): string {
  const url = new URL(process.env.CONTEXTUAL_DATABASE_URL ?? 'postgres://contextual:contextual@localhost:55432/contextual');
  return `Cannot reach Postgres at ${url.hostname}:${url.port || '5432'}${url.pathname}. Start it with docker compose up -d, or check CONTEXTUAL_DATABASE_URL.`;
}

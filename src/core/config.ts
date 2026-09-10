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
  CONTEXTUAL_UPLOAD_MAX_BYTES: [33554432, 1024, 268435456, true],
  CONTEXTUAL_UPLOAD_MAX_FILES: [20, 1, 200, true],
  CONTEXTUAL_OLLAMA_TIMEOUT_MS: [30000, 1, 3600000, true],
  CONTEXTUAL_OCR_TIMEOUT_MS: [60000, 1, 3600000, true],
  CONTEXTUAL_OCR_DOCUMENT_TIMEOUT_MS: [300000, 1, 3600000, true],
  CONTEXTUAL_OCR_MAX_PAGES: [200, 1, 10000, true],
} as const;
export function ocrMode(): 'reject' | 'local' | 'hosted' {
  const mode = process.env.CONTEXTUAL_OCR ?? 'reject';
  if (mode !== 'reject' && mode !== 'local' && mode !== 'hosted') {
    throw new Error('CONTEXTUAL_OCR must be reject, local, or hosted');
  }
  return mode;
}
export function ocrLanguage(): string {
  const language = process.env.CONTEXTUAL_OCR_LANGUAGE ?? 'eng';
  if (!/^[a-zA-Z0-9_]+(?:\+[a-zA-Z0-9_]+)*$/.test(language)) {
    throw new Error('CONTEXTUAL_OCR_LANGUAGE must contain Tesseract language names, such as eng or eng+deu');
  }
  return language;
}
export function embedProvider(): 'voyage' | 'ollama' | 'none' {
  const provider = process.env.CONTEXTUAL_EMBED_PROVIDER ?? 'voyage';
  if (provider !== 'voyage' && provider !== 'ollama' && provider !== 'none') {
    throw new Error('CONTEXTUAL_EMBED_PROVIDER must be voyage, ollama, or none');
  }
  return provider;
}
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
  embedProvider();
  ocrMode();
  ocrLanguage();
  if (process.env.CONTEXTUAL_RERANK && !['true', 'false'].includes(process.env.CONTEXTUAL_RERANK)) throw new Error('CONTEXTUAL_RERANK must be true or false');
}
export function configHelp(): string {
  return Object.entries(NUMERIC_SETTINGS).map(([key, [value]]) => `  ${key.padEnd(37)} default: ${value}`).join('\n');
}
export function databaseHint(): string {
  const url = new URL(process.env.CONTEXTUAL_DATABASE_URL ?? 'postgres://contextual:contextual@localhost:55432/contextual');
  return `Cannot reach Postgres at ${url.hostname}:${url.port || '5432'}${url.pathname}. Start it with docker compose up -d, or check CONTEXTUAL_DATABASE_URL.`;
}

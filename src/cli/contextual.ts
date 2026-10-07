#!/usr/bin/env bun
import { validateConfig, databaseHint } from '../core/config';
try {
  if (['doctor', 'init'].includes(Bun.argv[2] ?? '')) {
    await (await import('./setup')).runSetup(Bun.argv.slice(2));
  } else {
    validateConfig();
    await import('./commands');
  }
} catch (err) {
  const message = (err as Error).message;
  console.error(`✗ ${message}`);
  if (/connect|ECONNREFUSED/i.test(message)) console.error(databaseHint());
  process.exitCode = 1;
}

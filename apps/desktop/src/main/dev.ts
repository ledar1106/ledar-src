/**
 * The development smoke run, and nothing else.
 *
 * The acceptance test for this slice is a sentence from a real database, and
 * a window is hard to drive from a test runner. So, in a development build
 * only, the app can prefill the connection form from the same place
 * `npm run check:db` reads (TEST_PG_DSN, or infra/.env), connect on its own,
 * and print the verdict to stdout where a script can read it.
 *
 * Every part of it is opt-in by environment flag and dead in a packaged
 * build. Without the flags, `npm run desktop` never touches infra/.env —
 * the operator's scanning DSN does not belong in the renderer of a window
 * somebody opened to look at the welcome screen.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { DevPrefill } from '../shared/ipc.js';

export function devPrefill(isPackaged: boolean, repoRoot: string): DevPrefill {
  if (isPackaged) return null;

  const wantsPrefill = process.env.LEDAR_DEV_PREFILL === '1';
  const wantsAutoconnect = process.env.LEDAR_DEV_AUTOCONNECT === '1';
  if (!wantsPrefill && !wantsAutoconnect) return null;

  const dsn =
    process.env.LEDAR_DEV_DSN?.trim() ||
    process.env.TEST_PG_DSN?.trim() ||
    readDsnFromEnvFile(repoRoot);
  if (!dsn) return null;

  return {
    dsn,
    autoconnect: wantsAutoconnect,
    exitWhenProven: process.env.LEDAR_DEV_EXIT === '1',
  };
}

/** The same fallback `check:db` uses. The value is handed on, never printed. */
function readDsnFromEnvFile(repoRoot: string): string | null {
  let text: string;
  try {
    text = readFileSync(resolve(repoRoot, 'infra', '.env'), 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*TEST_PG_DSN\s*=\s*(.+)$/.exec(line);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

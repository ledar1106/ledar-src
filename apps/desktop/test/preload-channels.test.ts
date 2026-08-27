/**
 * The bridge cannot import the channel names, so they are written twice.
 *
 * preload.cts runs sandboxed and self-contained: it cannot require
 * shared/ipc.ts, so its channel strings are literals. main's handlers
 * register from `CHANNELS`. Two spellings of the same wire is exactly the
 * kind of drift that breaks at run time with no compiler in the way —
 * this test is the compiler for it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { CHANNELS } from '../src/shared/ipc.js';

const preloadSource = readFileSync(
  fileURLToPath(new URL('../src/preload/preload.cts', import.meta.url)),
  'utf8',
);

describe('preload channel literals', () => {
  it('spells every channel exactly as the shared contract does', () => {
    for (const [name, channel] of Object.entries(CHANNELS)) {
      assert.ok(
        preloadSource.includes(`'${channel}'`),
        `preload.cts is missing the literal '${channel}' for CHANNELS.${name}`,
      );
    }
  });

  it('invokes no channel the contract does not name', () => {
    const used = [...preloadSource.matchAll(/'(ledar:[a-z-]+)'/g)].map((m) => m[1]);
    const known = new Set<string>(Object.values(CHANNELS));
    for (const channel of used) {
      assert.ok(channel !== undefined && known.has(channel), `preload uses unknown channel ${channel}`);
    }
    assert.ok(used.length >= Object.keys(CHANNELS).length);
  });
});

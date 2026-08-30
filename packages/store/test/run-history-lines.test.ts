/**
 * What the report says about the history file — the reader's side of N54.
 *
 * `RunHistory.lines()` is prose that goes straight onto a screen and into a
 * terminal, and until now nothing held it. codegraph reported the class with
 * no covering tests at all, which is how the sentence below came to be missing
 * without anything noticing.
 *
 * ## The sentence, and why run 1
 *
 * A packaged build used to write its history inside the package's own
 * container, so uninstalling LEDAR took the history with it. The manifest now
 * excludes that one directory — right, because a scan history is the person's
 * record of their database rather than the app's cache — but it is a CHANGE IN
 * BEHAVIOUR. An uninstall that quietly leaves files behind is a surprise, and
 * this product does not get to make that one silently.
 *
 * Said on run 1 only. A four-line paragraph at the foot of every report is how
 * a reader learns to skip the foot of every report; run 1 is exactly when a
 * new file has come into existence, and a retirement restarts the numbering so
 * a replacement file gets the sentence too.
 *
 * ## Two mutations survived the first version of this file
 *
 * Both were faults in the tests, not the code, and both are the shape this
 * repository keeps writing down — a case where two implementations agree tests
 * neither:
 *
 *   - *"says it once"* opened two histories in two fresh directories, so both
 *     were run 1. It could not tell a rule that fires on run 1 from one that
 *     fires on every run.
 *   - *"names the file"* matched the whole report, and `history: recorded as
 *     run 1 in <path>` carries the file name too. The assertion passed on a
 *     different line from the one it was about.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { RunHistory } from '../src/run-history.js';
import type { ScopeManifest } from '@ledar/contracts';

const dirs: string[] = [];
const opened: RunHistory[] = [];

after(() => {
  // Closed before the directories go, or Windows refuses to remove a file
  // SQLite still holds open and the whole file reports a failure that has
  // nothing to do with any assertion in it. `complete` is what closes a run.
  for (const h of opened) h.complete({ queries: 0, totalMs: 0, rowsScanned: 0 }, null);
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ledar-lines-'));
  dirs.push(dir);
  return dir;
}

function scope(): ScopeManifest {
  return {
    database: 'shop',
    role: 'ledar_reader',
    schemas: ['public'],
    visibleTables: 3,
    totalTables: 3,
    grantedAt: null,
    readOnlyEnforcedByDatabase: true,
    disclosure: null,
  };
}

/**
 * A history in a throwaway directory, so no test touches a real one.
 *
 * 🟥 Takes the directory, and that is not tidiness. The first version made a
 * fresh one on every call, so two runs were always two run 1s.
 */
async function historyIn(dir: string = workspace()): Promise<RunHistory> {
  const before = process.env['LEDAR_HISTORY_DB'];
  process.env['LEDAR_HISTORY_DB'] = join(dir, 'history.db');
  try {
    const history = await RunHistory.open(
      'postgresql://someone@localhost:5432/shop',
      scope(),
    );
    opened.push(history);
    return history;
  } finally {
    if (before === undefined) delete process.env['LEDAR_HISTORY_DB'];
    else process.env['LEDAR_HISTORY_DB'] = before;
  }
}

describe('what the report says about the history file', () => {
  it('🟥 run 1 says the file survives an uninstall, and names it', async () => {
    const history = await historyIn();
    const notice = history.lines().find((l) => /stays if you uninstall LEDAR/.test(l));

    assert.ok(
      notice !== undefined,
      'the run that CREATES the history file says nothing about the file ' +
        'outliving the app. Removing LEDAR used to remove it; now it does ' +
        'not, and an uninstall that silently leaves a file behind is a ' +
        'surprise rather than a decision.',
    );

    // 🟥 Asserted on THAT line, not on the report. `history: recorded as run 1
    // in <path>` also carries the file name, so matching the whole text passed
    // even when the sentence itself named nothing.
    assert.match(
      notice,
      /history\.db/,
      'the sentence says the file stays without saying WHICH file, so nobody ' +
        'told to delete it can find it',
    );
  });

  it('🟥 says it once — not at the foot of every later report', async () => {
    const dir = workspace();

    const first = await historyIn(dir);
    assert.match(
      first.lines().join('\n'),
      /stays if you uninstall/,
      'run 1 created the file and did not mention that it outlives the app',
    );
    // Closed so the second run opens the SAME file rather than a locked one.
    first.complete({ queries: 0, totalMs: 0, rowsScanned: 0 }, null);

    const second = await historyIn(dir);
    const said = second.lines().join('\n');
    assert.match(said, /recorded as run 2/, 'the second run did not reuse the file');
    assert.doesNotMatch(
      said,
      /stays if you uninstall/,
      'every scan repeats the paragraph about uninstalling. A notice at the ' +
        'foot of every report is how a reader learns to skip the foot of every ' +
        'report; it belongs on the run that CREATED the file.',
    );
  });

  it('always names the run and the file it went into', async () => {
    const history = await historyIn();
    assert.match(history.lines().join('\n'), /recorded as run 1/);
  });
});

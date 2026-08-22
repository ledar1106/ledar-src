/**
 * `npm run diff`, as a command, against history files it has never met.
 *
 * The part worth testing here is not the comparison — `store/test/diff.test.ts`
 * owns that, without a file anywhere in sight. What this owns is the thing
 * that made the comparison reachable at all: **a user's history is not one
 * file**, and a command that read only the live one would report "there is
 * nothing to compare" while standing in a directory holding a year of runs.
 *
 * So every test below builds a directory that looks like a real
 * `%LOCALAPPDATA%\ledar` after a schema bump — a live `history.db` beside a
 * retired `history.v1.db` — and asks the command what it can see.
 *
 * `LEDAR_HISTORY_DB` points the child at that directory. It is set rather
 * than deleted, which is the opposite of `scan-default-history.test.ts` and
 * for the opposite reason: that suite is about the default path being right,
 * and this one must never touch the operator's real history, because the
 * command it runs walks every sibling file it can find.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { FIXTURE_FINGERPRINT, writeLegacyHistory } from '@ledar/test-fixtures';

import { handlePrefix, retiredSiblings } from '../src/diff.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const DIFF_TIMEOUT_MS = 60_000;

const ORPHANS = 'layer-a/unvalidated-foreign-key-has-orphans';
const KEY = 'layer-a/fk-orphans/public.damaged_rental_note.fk';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

type Ran = { code: number | null; stdout: string; stderr: string };

function runDiff(args: string, historyDb: string): Promise<Ran> {
  return new Promise((done) => {
    const child = spawn(`npm run diff -- ${args}`, {
      cwd: REPO_ROOT,
      shell: true,
      timeout: DIFF_TIMEOUT_MS,
      env: { ...process.env, LEDAR_HISTORY_DB: historyDb },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

/**
 * A data directory shaped like one that has been through a schema bump.
 *
 * `history.v1.db` holds the older run; `history.db` — written here through
 * the legacy builder at schema 2 rather than through `ScanStore`, so the two
 * sides can be given hashes on purpose — holds the newer one. The command has
 * to find both without being told the first exists.
 */
function twoEras(opts: { newRows?: number; extraKey?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'ledar-diffcli-'));
  dirs.push(dir);

  writeLegacyHistory(join(dir, 'history.v1.db'), 1, [
    {
      runId: 11,
      startedAt: '2026-08-21T04:49:52.760Z',
      label: 'pagila',
      fingerprint: FIXTURE_FINGERPRINT,
      findings: [{ findingKey: KEY, rule: ORPHANS, rowCount: 3 }],
      rules: [{ rule: ORPHANS, checked: 1, eligible: 1 }],
    },
  ]);

  const findings = [
    { findingKey: KEY, rule: ORPHANS, rowCount: opts.newRows ?? 3 },
    ...(opts.extraKey === undefined
      ? []
      : [{ findingKey: opts.extraKey, rule: ORPHANS, rowCount: 9 }]),
  ];
  writeLegacyHistory(join(dir, 'history.db'), 2, [
    {
      runId: 1,
      startedAt: '2026-08-22T05:00:44.063Z',
      label: 'pagila',
      fingerprint: FIXTURE_FINGERPRINT,
      findings,
      rules: [{ rule: ORPHANS, checked: 1, eligible: 1 }],
    },
  ]);

  return join(dir, 'history.db');
}

describe('finding the runs that are not in the live file', () => {
  it('matches only the names retirement actually produces', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledar-diffsib-'));
    dirs.push(dir);
    const live = join(dir, 'history.db');
    writeLegacyHistory(live, 2, []);
    writeLegacyHistory(join(dir, 'history.v1.db'), 1, []);
    writeLegacyHistory(join(dir, 'history.v1.2.db'), 1, []);
    // Neither of these came from `retiredName`, and adopting them would mean
    // this command's answer depended on what else the user keeps in their
    // data directory.
    writeLegacyHistory(join(dir, 'history-backup.db'), 1, []);
    writeLegacyHistory(join(dir, 'evidence.db'), 1, []);

    assert.deepEqual(
      retiredSiblings(live).map((p) => p.slice(dir.length + 1)),
      ['history.v1.2.db', 'history.v1.db'],
    );
  });

  it('turns a retired file name into the handle a user types', () => {
    assert.equal(handlePrefix('/x/history.v1.db', '/x/history.db'), 'v1');
    assert.equal(handlePrefix('/x/history.v1.2.db', '/x/history.db'), 'v1.2');
  });
});

describe('npm run diff', () => {
  it('lists runs from the retired file beside the live one', async () => {
    const ran = await runDiff('--list', twoEras());
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stdout.includes('2 runs, oldest first'), true, ran.stdout);
    // The handle, not the bare run id. Both files hold a run whose id is a
    // small number, and `11` alone would be ambiguous the moment a live
    // history reaches eleven runs.
    assert.match(ran.stdout, /run v1:11/);
    assert.match(ran.stdout, /run 1\b/);
  });

  it('compares the newest two runs across the two files without being asked', async () => {
    const ran = await runDiff('', twoEras({ newRows: 18 }));
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /from\s+run v1:11/);
    assert.match(ran.stdout, /to\s+run 1/);
    assert.match(ran.stdout, /Worse \(1\)/);
    assert.match(ran.stdout, /Worse: 18 rows, was 3\./);
  });

  it('warns, above the list, that the earlier file cannot say which rule ran', async () => {
    const ran = await runDiff('', twoEras({ newRows: 18 }));
    const caution = ran.stdout.indexOf('Read this before the list');
    const worse = ran.stdout.indexOf('Worse (1)');
    assert.notEqual(caution, -1, ran.stdout);
    assert.notEqual(worse, -1, ran.stdout);
    // A caution printed after the numbers is one that arrives too late to
    // change how the numbers were read.
    assert.ok(caution < worse, 'the caution must come before the findings');
  });

  it('names a run that appeared, and refuses to say whose fault it is', async () => {
    const ran = await runDiff('', twoEras({ extraKey: 'layer-a/fk-orphans/public.other.fk' }));
    assert.match(ran.stdout, /New \(1\)/);
    assert.match(ran.stdout, /public\.other\.fk/);
    assert.match(ran.stdout, /cannot be told from here/);
  });

  it('hides unchanged findings until asked, and says how many there are', async () => {
    const quiet = await runDiff('', twoEras());
    assert.match(quiet.stdout, /Unchanged \(1\) — pass --all to list them/);
    assert.ok(!quiet.stdout.includes(KEY), 'the key should not be listed without --all');

    const loud = await runDiff('--all', twoEras());
    assert.match(loud.stdout, /Unchanged \(1\)/);
    assert.ok(loud.stdout.includes(KEY), '--all should list it');
  });

  it('reads an out-of-date live history instead of crashing on it', async () => {
    // The window between a schema bump and the next scan. `history.db` is
    // still the old version because nothing has retired it yet, and that is
    // exactly when somebody asks what changed.
    const live = twoEras();
    const ran = await runDiff('--list', live);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /history\.db · schema 2/);
  });

  it('does not retire the file it read, because reading is all it was asked to do', async () => {
    const live = twoEras();
    const dir = dirname(live);
    const before = readdirSync(dir).sort();
    const ran = await runDiff('', live);
    assert.equal(ran.code, 0, ran.stderr);
    // `openHistory` would have renamed `history.db` to `history.v2.db` and
    // opened a fresh one. A user who asked what changed did not ask to have
    // their history rotated, and a read-only command that moves files is one
    // nobody can safely run twice.
    assert.deepEqual(readdirSync(dir).sort(), before);
  });

  it('prints the standing limits of finding identity every time', async () => {
    const ran = await runDiff('', twoEras());
    assert.match(ran.stdout, /What a comparison like this cannot see/);
    assert.match(ran.stdout, /renamed table/);
  });
});

describe('what npm run diff refuses', () => {
  it('refuses when there is only one run, rather than comparing it to nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledar-diffone-'));
    dirs.push(dir);
    const live = join(dir, 'history.db');
    writeLegacyHistory(live, 2, [
      { runId: 1, startedAt: '2026-08-22T05:00:44.063Z', fingerprint: FIXTURE_FINGERPRINT },
    ]);

    const ran = await runDiff('', live);
    assert.equal(ran.code, 1, ran.stdout);
    assert.match(ran.stderr, /needs two/);
  });

  it('refuses an unknown handle and says how to find the real ones', async () => {
    const ran = await runDiff('--run 9001', twoEras());
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /--list/);
    assert.match(ran.stderr, /v1:11/);
  });

  it('refuses to compare a run with itself', async () => {
    const ran = await runDiff('--run 1 --against 1', twoEras());
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /true and useless/);
  });

  it('refuses a flag it does not know rather than ignoring it', async () => {
    // A silently ignored flag is how somebody comes to believe they filtered
    // a report that was never filtered.
    const ran = await runDiff('--since yesterday', twoEras());
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /I do not know what/);
  });

  it('refuses when there is no history at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledar-diffnone-'));
    dirs.push(dir);
    const ran = await runDiff('', join(dir, 'history.db'));
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /no scan history/);
  });
});

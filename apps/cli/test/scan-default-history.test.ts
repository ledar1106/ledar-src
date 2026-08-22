/**
 * The default history path, exercised on the path a user actually takes.
 *
 * Debt N24. Every other scan test sets `LEDAR_HISTORY_DB`, so the branch that
 * decides where history goes when nobody says — the branch every real user
 * hits — was never reached by anything. The rule lives in one place now
 * (`apps/cli/src/paths.ts`, with property tests of its own), but "one rule"
 * and "one rule, with evidence that both callers reach it" are different
 * claims, and only the second survives somebody inlining a path back into
 * `scan.ts` because it seemed simpler.
 *
 * That is not hypothetical either. The two platform branches used to be
 * written out twice — once here, once in `export-evidence.ts` — and the copy
 * with no test is the copy that drifted.
 *
 * How this avoids writing into the operator's own history: it does not move
 * the history file, it moves the DATA DIRECTORY, using the variables the
 * product already reads. No new environment variable is invented for a test;
 * one more way to relocate somebody's history is product surface, not test
 * scaffolding.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { PAGILA_DSN, announceSkip, openPagila } from '@ledar/test-fixtures';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const SUITE = 'the default history path, with nobody naming it';
const SCAN_TIMEOUT_MS = 180_000;

/**
 * The variables the product already reads to decide where its data lives.
 *
 * Mirrors `dataDirRedirectedTo` in export-evidence.test.ts deliberately rather
 * than sharing it: that one is about where an Evidence Pack lands, this one is
 * about where a history lands, and they are allowed to stop agreeing. If they
 * ever do, that is a fact worth discovering, not a duplication to remove.
 */
function dataDirRedirectedTo(base: string): NodeJS.ProcessEnv {
  if (process.platform === 'win32') return { LOCALAPPDATA: base, USERPROFILE: base };
  if (process.platform === 'darwin') return { HOME: base };
  return { XDG_DATA_HOME: base, HOME: base };
}

/** Where `ledarDir()` should put things, given the redirect above. */
function expectedLedarDir(base: string): string {
  if (process.platform === 'win32') return join(base, 'ledar');
  if (process.platform === 'darwin') return join(base, 'Library', 'Application Support', 'ledar');
  return join(base, 'ledar');
}

const gate = await openPagila();

if (!gate.ok) {
  announceSkip(SUITE, gate.reason);
  // Registered as a skipped test, not a skipped suite: a suite that vanishes
  // from the totals reads as "nothing to do here", a skipped test reads as a
  // hole. `skipped > 0` is not green.
  describe(SUITE, () => {
    it('the scan was not run', { skip: gate.reason }, () => {
      assert.fail('unreachable: this test is skipped');
    });
  });
} else {
  await gate.client.end();

  let base = '';
  let stdout = '';
  let stderr = '';
  let code: number | null = null;

  describe(SUITE, () => {
    before(async () => {
      base = mkdtempSync(join(tmpdir(), 'ledar-defaulthist-'));

      // The one thing this suite must get right: LEDAR_HISTORY_DB is DELETED
      // from the child's environment, not set to something. A value inherited
      // from the operator's shell would send the run at their real history and
      // this test would pass while proving nothing about the default branch.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...dataDirRedirectedTo(base),
        TEST_PG_DSN: PAGILA_DSN,
        LEDAR_SCHEMAS: 'public',
      };
      delete env.LEDAR_HISTORY_DB;

      await new Promise<void>((done) => {
        const child = spawn('npm run scan', {
          cwd: REPO_ROOT,
          shell: true,
          timeout: SCAN_TIMEOUT_MS,
          env,
        });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (d: string) => (stdout += d));
        child.stderr.on('data', (d: string) => (stderr += d));
        child.on('close', (c) => {
          code = c;
          done();
        });
      });
    });

    after(() => {
      if (base) rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    });

    it('the scan finishes', () => {
      assert.equal(
        code,
        0,
        `npm run scan exited ${code}. Last of stderr:\n${stderr.split(/\r?\n/).slice(-8).join('\n')}`,
      );
    });

    it('the history lands under the redirected data directory, not the real one', () => {
      const expected = join(expectedLedarDir(base), 'history.db');

      assert.ok(
        existsSync(expected),
        `no history at ${expected}. The default branch put it somewhere else, ` +
          `which on an operator's machine means their own history file. What ` +
          `the scan said about history:\n` +
          stdout
            .split(/\r?\n/)
            .filter((l) => l.includes('history:'))
            .join('\n'),
      );

      // And the report has to name it. A history written where nobody is told
      // is a history nobody can find, export, or delete.
      assert.match(
        stdout,
        /history: recorded as run \d+ in /,
        'the scan did not say where it recorded the run',
      );
      assert.ok(
        stdout.includes(expected),
        `the scan recorded to ${expected} and printed a different path. The ` +
          `sentence a user reads is the only way they learn where their ` +
          `history is.`,
      );
    });

    it('nothing was written outside the redirected directory', () => {
      // The failure this catches is a partial redirect: one of the two
      // variables read, the other ignored, so the history lands half in the
      // temp directory and half in the operator's home. Every path the scan
      // printed has to sit under `base`.
      const printed = stdout
        .split(/\r?\n/)
        .map((l) => l.match(/ in (.+\.db)\s*$/)?.[1])
        .filter((p): p is string => typeof p === 'string');

      assert.ok(printed.length > 0, 'the scan printed no history path at all');
      for (const p of printed) {
        assert.ok(
          resolve(p).startsWith(resolve(base)),
          `the scan wrote history to ${p}, outside the redirected data ` +
            `directory ${base}. On a real machine that is the operator's own ` +
            `history file, written to by a test.`,
        );
      }
    });
  });
}

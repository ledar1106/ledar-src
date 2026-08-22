/**
 * Smoke test: the command a person actually types still works.
 *
 * The two layer suites call `runLayerA()` and `runImplicitForeignKeys()`
 * directly, which proves the rules are right and proves nothing about the
 * thing shipped. Between those functions and the user sits the DSN reader,
 * the privilege check, the budget split, the scope report and the printer —
 * any of which can break while every unit assertion stays green.
 *
 * So this runs `npm run scan` as a subprocess, exactly as HANDOFF-STATUS
 * section 1b tells the next person to run it, and checks that it comes back
 * with exit code 0.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PAGILA_DSN,
  announceSkip,
  openPagila,
  redactDsn,
} from '@ledar/test-fixtures';

const SUITE = 'npm run scan against the Pagila fixture';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** How long the scan gets before it is treated as hung. */
const SCAN_TIMEOUT_MS = 120_000;

/**
 * Table names that have to appear in the output.
 *
 * Names, not sentences. Every explanatory line in the report is prose that
 * will be reworded, and pinning a test to prose produces failures that mean
 * nothing — which is how a check gets muted. A table name is structure: if
 * `damaged_slug` stops being printed, something real broke.
 *
 * `damaged_external_ref` is deliberately absent from this list. It is the
 * false-positive trap, and it must never be reported as a fault; it is
 * checked separately below, for the opposite property.
 *
 * One name per finding, and the run's `findingCount` is asserted equal to
 * the length of this list further down. That equality is the reason the two
 * parent tables added with damage 6 and 7 — `damaged_tag` and
 * `damaged_asset` — are not here: they are the intact side of each broken
 * reference and produce no finding of their own. Loosening the equality to
 * `>=` would have been the cheap way to absorb the two new faults, and it
 * would also have absorbed a rule that started reporting a table twice.
 */
const MUST_APPEAR = [
  'damaged_rental_note',
  'damaged_payment_audit',
  'damaged_slug',
  'damaged_invoice',
  // damage 6 and 7: the two orphan columns that are not integers, added so
  // that redactCell's <text:N> and <uuid> branches run on real Postgres
  // rows rather than only on hand-written test values (debt N15).
  'damaged_tag_link',
  'damaged_asset_link',
  // damage 8: a composite NOT VALID foreign key over (text, uuid), so that
  // Layer A's row-wise redactRow sees something other than integers, and
  // sees a row with more than one cell in it (debt N20).
  'damaged_label_link',
  // damage 10: nineteen rows carrying one repeated value, and one genuine
  // orphan behind them. The name has to reach the screen for the SECOND
  // reason as much as the first — the report is showing a count of 1 where
  // the database has 20 unmatched, and the sentence that explains the gap is
  // printed with the finding or nowhere (debt N33).
  'damaged_sentinel_link',
  // damage 12: 42,000 clean rows then 18,000 unmatched ones, in that order
  // on disk. The old sampler read the clean head and reported nothing at
  // all, so this name appearing is the whole of the fix (debt N34).
  'damaged_wide_link',
  // damage 14: exactly one unmatched row, which the sentinel rule was
  // suppressing as a "repeated value" because one row is trivially 100% of
  // one row. Found on a real column of dba.stackexchange (debt N38).
  'damaged_lonely_link',
] as const;

/**
 * The trap, which has to be printed without being claimed.
 *
 * Layer B queries this column, finds that 0% of its values line up, and lets
 * it go. That decision is the product's most important output and the one
 * with nothing to show for itself: a scanner that stays silent about what it
 * ruled out is indistinguishable from a scanner that never looked. So the
 * name has to reach the screen.
 *
 * What this pins is only that the ruled-out group is printed at all — the
 * name appears nowhere else in the report. It says nothing about which
 * heading it appears under; that would mean asserting on prose, and the
 * heading is prose. The Layer B suite asserts the classification itself,
 * against the returned structure, where it can be stated exactly.
 */
const RULED_OUT_BUT_SHOWN = 'damaged_external_ref';

/**
 * The candidate that was never opened, which also has to be printed.
 *
 * The other way of not raising something, and the one that had never reached
 * a screen (debt N2). Layer B sets a candidate aside without querying it when
 * the child table's estimated size is over its threshold, and no Pagila table
 * was ever that size — so the "did not check" group existed, was printed by
 * `printSetAside`, and had been empty on every real run.
 *
 * An empty group prints nothing, which is right: there was no hole. But it
 * also means nobody had seen what a hole looks like when there is one, and a
 * coverage gap that has never been rendered is a coverage gap the reader will
 * meet for the first time on their own database.
 *
 * Like the ruled-out name above, this pins only that the group is printed at
 * all. The name appears nowhere else in the report — the table produces no
 * finding and is not among the ruled out — so its presence in stdout can only
 * come from that group. Which heading it sits under is prose, and the Layer B
 * suite asserts the classification itself against the returned structure.
 */
const NOT_EXAMINED_BUT_SHOWN = 'damaged_bulk_link';

/**
 * The scope strip, recognised by the two things about it that are not prose.
 *
 * It is a `·`-joined list of fields, and its first field names the unit the
 * whole line is anchored on. Nothing else the scan prints is both: the fact
 * lines and the cost line carry `·` and no tables, and `describeScope`'s
 * lines name tables and carry no `·`.
 *
 * The field labels are deliberately *not* pinned. They were, for one draft —
 * `\d+ checked` — and `scopeStripLine` was reworded to `\d+ targets checked`
 * the same afternoon, in a package this suite does not own. A pattern that
 * strict does not guard the strip, it guards a sentence, and the failure it
 * produces teaches whoever reads it to loosen the pattern. What must not be
 * loosened is the *degradation* check below, which is a separate assertion
 * with its own message.
 */
function isScopeStrip(line: string): boolean {
  return line.includes(' · ') && line.includes('tables visible');
}

/** How many `·`-joined fields a strip has at its narrowest. */
const SCOPE_STRIP_FIELDS = 4;

type Ran = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

/**
 * A history file of this suite's own, thrown away afterwards.
 *
 * Never the default location. That one belongs to whoever is running the
 * tests, and a suite that appends four runs of a fixture database to a
 * person's real scan history has changed something it was only supposed to
 * measure.
 */
const HISTORY_DIR = mkdtempSync(join(tmpdir(), 'ledar-scan-smoke-'));
const HISTORY_DB = join(HISTORY_DIR, 'history.db');

/**
 * The database as the history file will have filed it.
 *
 * Derived from the same DSN the scan is pointed at rather than written out
 * again, so this cannot quietly go looking for a run under a host the scan
 * never used and then report an empty history as a missing feature.
 */
const IDENTITY = (() => {
  const url = new URL(PAGILA_DSN);
  // Same precedence the scan uses, and the same one `pg` uses: a `host`
  // query parameter names a unix socket and overrides the authority.
  const socket = url.searchParams.get('host');
  return {
    host: socket !== null && socket !== '' ? socket : url.hostname,
    port: url.port === '' ? 5432 : Number(url.port),
    database: url.pathname.replace(/^\//, ''),
  };
})();

function runScan(): Promise<Ran> {
  return new Promise((resolvePromise, rejectPromise) => {
    // shell: true because npm is a .cmd on Windows and Node refuses to spawn
    // one directly. Passed as one constant string rather than an argv array:
    // Node deprecates the array form under a shell because it concatenates
    // without escaping, and there is nothing to escape here anyway — no part
    // of this command comes from a caller.
    const child = spawn('npm run scan', {
      cwd: REPO_ROOT,
      shell: true,
      timeout: SCAN_TIMEOUT_MS,
      env: {
        ...process.env,
        // Pinned, so a DSN left in the operator's shell cannot silently
        // redirect this at some other database.
        TEST_PG_DSN: PAGILA_DSN,
        LEDAR_SCHEMAS: 'public',
        LEDAR_HISTORY_DB: HISTORY_DB,
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));

    child.on('error', rejectPromise);
    child.on('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

const gate = await openPagila();

if (!gate.ok) {
  announceSkip(SUITE, gate.reason);

  // Registered as a skipped test rather than a skipped suite, so it lands in
  // the runner's "skipped" tally. A suite that disappears from the totals
  // reads as "nothing to do here"; a skipped test reads as a hole.
  describe(SUITE, () => {
    it('the scan was not run', { skip: gate.reason }, () => {
      assert.fail('unreachable: this test is skipped');
    });
  });
} else {
  // Only opened to prove the fixture is there. The scan opens its own.
  await gate.client.end();

  describe(SUITE, () => {
    /** One scan, read by both tests. Two runs would be two of everything. */
    let ran: Ran | undefined;

    before(async () => {
      ran = await runScan();
    });

    after(() => {
      rmSync(HISTORY_DIR, { recursive: true, force: true });
    });

    it(`exits 0 and names the ${MUST_APPEAR.length} faults it is meant to report`, () => {
      assert.ok(ran, 'the scan never ran');

      const tail = (s: string) => s.split(/\r?\n/).slice(-25).join('\n');

      assert.equal(
        ran.signal,
        null,
        `npm run scan was killed by ${ran.signal} — it did not finish within ` +
          `${SCAN_TIMEOUT_MS / 1000}s against ${redactDsn(PAGILA_DSN)}`,
      );
      assert.equal(
        ran.code,
        0,
        `npm run scan exited ${ran.code}.\n--- stderr (tail) ---\n${tail(ran.stderr)}\n` +
          `--- stdout (tail) ---\n${tail(ran.stdout)}`,
      );

      for (const name of MUST_APPEAR) {
        assert.ok(
          ran.stdout.includes(name),
          `"${name}" is missing from the scan output. The rule may still be ` +
            `right — the wiring between it and the printed report is not.`,
        );
      }
    });

    it('prints the candidate it checked and ruled out', () => {
      assert.ok(ran, 'the scan never ran');

      assert.ok(
        ran.stdout.includes(RULED_OUT_BUT_SHOWN),
        `"${RULED_OUT_BUT_SHOWN}" is missing from the scan output entirely. ` +
          `Layer B checked that column and let it go, and the report is now ` +
          `keeping that to itself — which reads exactly like never having ` +
          `looked. The restraint is the finding here.`,
      );
    });

    it('prints the candidate it never opened, and says no query was run', () => {
      assert.ok(ran, 'the scan never ran');

      assert.ok(
        ran.stdout.includes(NOT_EXAMINED_BUT_SHOWN),
        `"${NOT_EXAMINED_BUT_SHOWN}" is missing from the scan output entirely. ` +
          `Layer B set that column aside without querying it, and the report ` +
          `is keeping the gap to itself — which reads exactly like having ` +
          `checked it and found nothing. That is the one substitution this ` +
          `product exists to prevent.`,
      );
    });

    /**
     * VS-4: the one line the report may never be printed without.
     *
     * The acceptance criterion in BUILD-PROGRESS is not "the strip exists" —
     * it is that hiding it is a bug rather than a UI option. Existence is
     * satisfied by a strip printed once at the top, which two hundred lines
     * of findings then push off the screen; `_doc/05` §7 is explicit that a
     * disclosure only counts while it travels with the conclusion it limits.
     *
     * So this asserts POSITION, not presence: twice, identical, and the
     * second one below the last thing the scan had to say about the database.
     */
    it('prints the scope strip twice, the second time below the last finding', () => {
      assert.ok(ran, 'the scan never ran');

      const lines = ran.stdout.split(/\r?\n/);
      const stripAt = lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => isScopeStrip(line));

      assert.equal(
        stripAt.length,
        2,
        `the scope strip was printed ${stripAt.length} time(s). It is printed ` +
          `above the findings and again below them, unconditionally — one ` +
          `occurrence means the lower one was dropped and the boundary now ` +
          `stops travelling with what it bounds; none means the report is ` +
          `making claims with no stated scope at all.\n` +
          `--- stdout ---\n${ran.stdout}`,
      );

      const [above, below] = stripAt;
      assert.ok(above && below);
      assert.equal(
        above.line.trim(),
        below.line.trim(),
        'the two strips disagree. They describe one scan, so a difference ' +
          'means one of them was built from something other than what the ' +
          'scan actually covered.',
      );

      // The strip is allowed to say it does not know, and on this fixture it
      // must not. `scopeStripLine` spells an unstated total as `total
      // unknown` and a rule that could not state its denominator as `targets
      // eligible unknown (N rules could not say)`. Both are honest lines and
      // both are regressions here, where every number is countable: a rule
      // that has stopped being able to say how many targets it had takes the
      // whole line's total with it, and the report goes on printing without
      // one. Kept apart from the recognition above so the failure names the
      // half that broke.
      assert.doesNotMatch(
        above.line,
        /unknown/,
        `the strip reads "${above.line.trim()}". Every number on this line is ` +
          `countable against the fixture, so an unknown here is a rule that ` +
          `has stopped being able to state its own denominator — and the ` +
          `strip's total silently stops being a total.`,
      );
      assert.ok(
        above.line.split(' · ').length >= SCOPE_STRIP_FIELDS,
        `the strip reads "${above.line.trim()}" — ` +
          `${above.line.split(' · ').length} fields where there should be at ` +
          `least ${SCOPE_STRIP_FIELDS}. A field that stopped being printed ` +
          `leaves a line that still reads complete, which is the one thing ` +
          `this line must never do.`,
      );

      // Where the report's claims about this database begin and end. Taken
      // from the planted faults, whose names appear nowhere else — the trap
      // and the untouched candidate included, because the set-aside groups
      // are part of what the strip bounds.
      const claimNames = [...MUST_APPEAR, RULED_OUT_BUT_SHOWN, NOT_EXAMINED_BUT_SHOWN];
      const claimAt = lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => claimNames.some((name) => line.includes(name)))
        .map(({ i }) => i);

      // Nothing below is worth anything without this. With no finding lines
      // found, "the strip is after the last one" and "the strip is before the
      // first one" are both vacuously true, and the test would pass on a scan
      // that printed nothing but two strips.
      assert.ok(
        claimAt.length > 0,
        `no line of the report names any of the ${claimNames.length} planted ` +
          `faults, so there is nothing here to place the strip relative to. ` +
          `The positional assertions below would pass on an empty report.\n` +
          `--- stdout ---\n${ran.stdout}`,
      );

      const firstClaim = Math.min(...claimAt);
      const lastClaim = Math.max(...claimAt);

      assert.ok(
        above.i < firstClaim,
        `the first strip is on line ${above.i + 1} and the report's first ` +
          `finding is on line ${firstClaim + 1}. The reader met a claim ` +
          `before they were told what was looked at.`,
      );
      assert.ok(
        below.i > lastClaim,
        `the second strip is on line ${below.i + 1} but the last finding is ` +
          `on line ${lastClaim + 1}, below it. Whoever reads to the end of ` +
          `this report finishes on a finding with the boundary already ` +
          `scrolled away — which is the arrangement printing it twice exists ` +
          `to prevent.`,
      );
    });

    /**
     * The half of the scan that leaves no trace on screen.
     *
     * Everything above checks what was printed. A history nobody writes to
     * looks identical from the outside — the report is the same either way,
     * and the absence only shows up months later as a diff with nothing to
     * compare against. So this reads the file back.
     */
    it('records the run in the history file, with no sample rows in it', async () => {
      assert.ok(ran, 'the scan never ran');
      assert.match(
        ran.stdout,
        /history: recorded as run \d+ in /,
        'the scan did not say it had recorded anything. If it printed a ' +
          'reason instead, that reason is the failure worth reading.',
      );

      const { ScanStore } = await import('@ledar/store');
      const store = ScanStore.open(HISTORY_DB);

      try {
        const runs = store.runsFor(IDENTITY);
        assert.equal(runs.length, 1, 'expected exactly one recorded run');

        const run = runs[0];
        assert.ok(run);
        assert.equal(run.outcome, 'completed');
        assert.equal(run.findingCount, MUST_APPEAR.length);
        assert.ok(run.cost.queries > 0, 'a run that cost nothing did not happen');

        // Rule 6. The store defaults this off and refuses unredacted values
        // either way; this checks that the scan does not turn it on.
        assert.equal(
          run.samplesStored,
          false,
          'the scan asked the history to keep sample rows',
        );

        /**
         * Debt N30: every rule that ran has to be in the file, not just the
         * one that spoke last.
         *
         * Only Layer B's single rule used to reach the history. Layer A's
         * three sat a few lines away in the CLI — already built, already
         * printed in the scope strip on screen — and were dropped on the way
         * to disk. The report showed four denominators; the file kept one.
         *
         * That gap is the diff slice's problem in miniature. A rule that ran
         * and found nothing leaves exactly the same empty space as a rule
         * that never ran, and a coverage row is the only thing that separates
         * them. Without Layer A's rows a later diff cannot tell "the orphans
         * are gone" from "nobody looked this time" — and it would report the
         * cheerful one.
         */
        const recorded = store.rulesOf(run.runId).map((r) => r.rule);
        for (const rule of [
          'layer-a/unvalidated-foreign-key-has-orphans',
          'layer-a/unvalidated-check-is-violated',
          'layer-a/index-not-enforcing',
          'layer-b/undeclared-reference-with-unmatched-values',
        ]) {
          assert.ok(
            recorded.includes(rule),
            `${rule} ran during this scan and is not in the history file. ` +
              `Recorded: ${recorded.join(', ') || '(none)'}. A rule missing ` +
              `from the history is a rule a later diff will read as never ` +
              `having run.`,
          );
        }

        for (const rule of store.rulesOf(run.runId)) {
          assert.ok(
            rule.coverage,
            `${rule.rule} was recorded without a denominator. "It ran" and ` +
              `"it ran and looked at N of M" are different claims, and only ` +
              `the second is worth comparing against next month.`,
          );
        }

        assert.deepEqual(run.scope.schemas, ['public']);
        assert.equal(run.scope.database, 'pagila');
        assert.ok(run.scope.visibleTables > 0);
        assert.notEqual(
          run.scope.totalTables,
          null,
          'the scan stored "I do not know how many tables exist" for a ' +
            'database it had just counted them in',
        );
        assert.ok(
          run.scope.totalTables !== null &&
            run.scope.totalTables >= run.scope.visibleTables,
          'more tables were visible than exist',
        );

        for (const stored of store.findingsOf(run.runId)) {
          assert.equal(
            stored.finding.evidence?.sample.length ?? 0,
            0,
            `finding ${stored.findingKey} carried sample rows into the history`,
          );
        }

        // A rule that found nothing and a rule that never ran leave the same
        // empty space in the finding table. This is the column that tells
        // them apart, and it is only there if the scan wrote it.
        const rules = store.rulesOf(run.runId);
        assert.ok(
          rules.some((r) => r.rule.startsWith('layer-b/') && r.ran),
          'nothing in the history says Layer B ran',
        );

        // The gap printed on screen, written down where a later run can be
        // compared against it. `rulesOf` keeps the count of skipped targets
        // and not their names, so the claim here is the fraction: Layer B
        // considered more candidates than it checked. Before damage 9 those
        // two numbers were always equal on this fixture, so a scan that
        // stopped recording its coverage hole would have looked identical.
        const layerB = rules.find((r) => r.rule.startsWith('layer-b/'));
        const coverage = layerB?.coverage;
        assert.ok(coverage, 'Layer B recorded no coverage at all');

        const eligible = coverage.eligible;
        assert.ok(
          eligible !== null,
          'Layer B stored "I do not know how many candidates there were" for ' +
            'a run in which it had just counted them',
        );
        assert.ok(
          eligible > coverage.checked,
          `the history says Layer B checked ${coverage.checked} of ` +
            `${eligible} candidates. The fixture holds one it ` +
            `is supposed to leave alone for its size, so equal numbers mean ` +
            `the skip never reached the file — and a history that records ` +
            `full coverage for a partial scan is what makes the next diff a ` +
            `lie.`,
        );
        assert.ok(
          rules.some((r) => r.rule.startsWith('layer-a/') && r.ran),
          'nothing in the history says Layer A ran',
        );
      } finally {
        store.close();
      }
    });
  });
}

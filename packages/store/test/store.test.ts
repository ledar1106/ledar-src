import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';

import type { Finding, ScopeManifest } from '@ledar/contracts';

import { SCHEMA_VERSION } from '../src/schema.js';
import { ScanStore } from '../src/store.js';
import type { DatabaseIdentity } from '../src/types.js';
import { coverageOf } from '@ledar/contracts';

const DB: DatabaseIdentity = { host: '127.0.0.1', port: 55432, database: 'pagila' };

function scope(over: Partial<ScopeManifest> = {}): ScopeManifest {
  return {
    database: 'pagila',
    role: 'ledar_reader',
    schemas: ['public'],
    visibleTables: 47,
    totalTables: 52,
    grantedAt: null,
    readOnlyEnforcedByDatabase: true,
    disclosure: null,
    ...over,
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'layer-a/fk-orphans/public.damaged_rental_note.rental_fkey',
    rule: 'layer-a/unvalidated-foreign-key-has-orphans',
    kind: 'observation',
    confidence: 'certain',
    severity: 'high',
    origin: 'counted',
    confidenceBasis: 'full_count',
    egressClass: 'customer-system-metadata',
    observedAt: '2026-08-21T10:00:04.000Z',
    engineRuleVersion: 'layer-a@2.1.0',
    userStatus: 'unreviewed',
    schema: 'public',
    table: 'damaged_rental_note',
    columns: ['rental_id'],
    plainText: '3 rows point at a rental record that is not there.',
    technical: 'FK damaged_rental_note_rental_fkey is NOT VALID; 3 orphans.',
    evidence: {
      sql: 'SELECT count(*) FROM damaged_rental_note',
      rowCount: 3,
      sampleSize: null,
      durationMs: 1.5,
      sample: [],
    },
    coverage: coverageOf(1, 1),
    ...over,
  } as Finding;
}

const NO_COST = { queries: 0, totalMs: 0, rowsScanned: 0 };

// ---- a run, start to finish ------------------------------------------------

test('a run round-trips: scope, cost, findings', () => {
  const store = ScanStore.memory();

  const runId = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-21T10:00:00Z' });
  store.recordFindings(runId, [finding()]);
  store.finishRun(runId, {
    finishedAt: '2026-08-21T10:00:09Z',
    outcome: 'completed',
    cost: { queries: 9, totalMs: 41, rowsScanned: 30_070 },
  });

  const run = store.runById(runId);
  assert.ok(run);
  assert.equal(run.outcome, 'completed');
  assert.equal(run.startedAt, '2026-08-21T10:00:00.000Z');
  assert.equal(run.finishedAt, '2026-08-21T10:00:09.000Z');
  assert.equal(run.scope.visibleTables, 47);
  assert.equal(run.scope.totalTables, 52);
  assert.equal(run.scope.readOnlyEnforcedByDatabase, true);
  assert.deepEqual(run.cost, { queries: 9, totalMs: 41, rowsScanned: 30_070 });
  assert.equal(run.costTruncated, false);
  assert.equal(run.findingCount, 1);
  assert.equal(run.label, 'pagila');

  const stored = store.findingsOf(runId);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0]?.finding, finding());

  store.close();
});

// ---- the two denominators --------------------------------------------------

test('an unknown table total stays unknown and never becomes zero', () => {
  const store = ScanStore.memory();
  const runId = store.openRun({
    database: DB,
    scope: scope({ visibleTables: 47, totalTables: null }),
  });

  const run = store.runById(runId);
  assert.equal(run?.scope.totalTables, null);
  assert.notEqual(run?.scope.totalTables, 0);
  store.close();
});

test('a genuine zero is kept apart from an unknown', () => {
  const store = ScanStore.memory();
  const runId = store.openRun({
    database: DB,
    scope: scope({ visibleTables: 0, totalTables: 0 }),
  });
  assert.equal(store.runById(runId)?.scope.totalTables, 0);
  store.close();
});

test('leaving the total out is refused rather than read as unknown', () => {
  const store = ScanStore.memory();
  const incomplete = scope() as Partial<ScopeManifest>;
  delete incomplete.totalTables;

  assert.throws(
    () => store.openRun({ database: DB, scope: incomplete as ScopeManifest }),
    /totalTables is undefined/,
  );
  store.close();
});

test('the two denominators cannot be stored the wrong way round', () => {
  const store = ScanStore.memory();
  assert.throws(
    () => store.openRun({ database: DB, scope: scope({ visibleTables: 52, totalTables: 47 }) }),
    /swapped/,
  );
  store.close();
});

test('a scope about a different database is refused', () => {
  const store = ScanStore.memory();
  assert.throws(
    () => store.openRun({ database: DB, scope: scope({ database: 'supabase' }) }),
    /different database/,
  );
  store.close();
});

// ---- history ---------------------------------------------------------------

test('runs come back newest first, for that database only', () => {
  const store = ScanStore.memory();
  const other: DatabaseIdentity = { host: '127.0.0.1', port: 54322, database: 'db' };

  const first = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-01T00:00:00Z' });
  store.finishRun(first, { outcome: 'completed', cost: NO_COST, finishedAt: '2026-08-01T00:01:00Z' });

  const second = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-15T00:00:00Z' });
  store.finishRun(second, { outcome: 'completed', cost: NO_COST, finishedAt: '2026-08-15T00:01:00Z' });

  const elsewhere = store.openRun({
    database: other,
    scope: scope({ database: 'db' }),
    startedAt: '2026-08-20T00:00:00Z',
  });
  store.finishRun(elsewhere, { outcome: 'completed', cost: NO_COST });

  const runs = store.runsFor(DB);
  assert.deepEqual(
    runs.map((r) => r.runId),
    [second, first],
  );
  assert.equal(store.runsFor(other).length, 1);
  store.close();
});

test('one finding can be read across the runs it appeared in', () => {
  const store = ScanStore.memory();

  const first = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-01T00:00:00Z' });
  store.recordFindings(first, [finding()]);
  store.finishRun(first, { outcome: 'completed', cost: NO_COST, finishedAt: '2026-08-01T00:01:00Z' });

  const second = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-15T00:00:00Z' });
  store.recordFindings(second, [
    finding({
      severity: 'critical',
      evidence: {
        sql: 'SELECT count(*) FROM damaged_rental_note',
        rowCount: 41,
        sampleSize: null,
        durationMs: 2,
        sample: [],
      },
    }),
  ]);
  store.finishRun(second, { outcome: 'completed', cost: NO_COST, finishedAt: '2026-08-15T00:01:00Z' });

  const history = store.historyOf(DB, finding().id);
  assert.equal(history.length, 2);

  const [now, before] = history;
  assert.ok(now && before);
  assert.equal(now.measuredRows, 41);
  assert.equal(before.measuredRows, 3);
  // Severity moved, so the structure hash moved too: this is a verdict
  // change, not only more rows.
  assert.notEqual(now.structureHash, before.structureHash);

  store.close();
});

test('more rows with the same verdict reads as a data change, not a structure change', () => {
  const store = ScanStore.memory();

  const first = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-01T00:00:00Z' });
  store.recordFindings(first, [finding()]);
  store.finishRun(first, { outcome: 'completed', cost: NO_COST, finishedAt: '2026-08-01T00:01:00Z' });

  const second = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-15T00:00:00Z' });
  store.recordFindings(second, [
    finding({
      evidence: {
        sql: 'SELECT count(*) FROM damaged_rental_note',
        rowCount: 12,
        sampleSize: null,
        durationMs: 2,
        sample: [],
      },
    }),
  ]);
  store.finishRun(second, { outcome: 'completed', cost: NO_COST, finishedAt: '2026-08-15T00:01:00Z' });

  const [now, before] = store.historyOf(DB, finding().id);
  assert.ok(now && before);
  assert.equal(now.structureHash, before.structureHash);
  assert.notEqual(now.measuredRows, before.measuredRows);
  store.close();
});

// ---- a vanished finding is not automatically a fixed one -------------------

test('a rule that never ran is recorded, so its silence is not read as a fix', () => {
  const store = ScanStore.memory();

  const runId = store.openRun({ database: DB, scope: scope() });
  store.recordRules(runId, [
    {
      rule: 'layer-b/undeclared-reference-with-unmatched-values',
      ran: false,
      note: 'Budget was spent by layer A before this rule got a turn.',
    },
  ]);
  store.finishRun(runId, {
    outcome: 'completed',
    cost: { queries: 200, totalMs: 4000, rowsScanned: 12 },
    truncationNote: 'Stopped early: this scan is allowed 200 queries.',
  });

  const rules = store.rulesOf(runId);
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.ran, false);
  assert.equal(rules[0]?.coverage, undefined);

  const run = store.runById(runId);
  assert.equal(run?.costTruncated, true);
  assert.match(run?.truncationNote ?? '', /Stopped early/);
  store.close();
});

test('a rule that produced a finding is known to have run', () => {
  const store = ScanStore.memory();
  const runId = store.openRun({ database: DB, scope: scope() });
  store.recordFindings(runId, [finding()]);

  const rules = store.rulesOf(runId);
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.rule, 'layer-a/unvalidated-foreign-key-has-orphans');
  assert.equal(rules[0]?.ran, true);
  // Inferred, so it must not claim coverage numbers nobody supplied.
  assert.equal(rules[0]?.coverage, undefined);
  store.close();
});

test('declared coverage wins over the inferred row', () => {
  const store = ScanStore.memory();
  const runId = store.openRun({ database: DB, scope: scope() });
  store.recordFindings(runId, [finding()]);
  store.recordRules(runId, [
    {
      rule: 'layer-a/unvalidated-foreign-key-has-orphans',
      ran: true,
      coverage: coverageOf(4, 6),
    },
  ]);

  const rules = store.rulesOf(runId);
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.coverage?.checked, 4);
  assert.equal(rules[0]?.coverage?.eligible, 6);
  store.close();
});

// ---- a run that never came back --------------------------------------------

test('an interrupted run stays visibly unfinished', () => {
  const store = ScanStore.memory();
  const runId = store.openRun({ database: DB, scope: scope() });
  store.recordFindings(runId, [finding()]);

  const run = store.runById(runId);
  assert.equal(run?.outcome, 'running');
  assert.equal(run?.finishedAt, null);
  store.close();
});

test('a run cannot be finished twice, or relabelled after the fact', () => {
  const store = ScanStore.memory();
  const runId = store.openRun({ database: DB, scope: scope() });
  store.finishRun(runId, { outcome: 'failed', note: 'connection dropped', cost: NO_COST });

  assert.throws(
    () => store.finishRun(runId, { outcome: 'completed', cost: NO_COST }),
    /already ended/,
  );
  assert.throws(() => store.recordFindings(runId, [finding()]), /already ended/);
  store.close();
});

test('a run that did not complete has to say why', () => {
  const store = ScanStore.memory();
  const runId = store.openRun({ database: DB, scope: scope() });
  assert.throws(
    () => store.finishRun(runId, { outcome: 'refused', cost: NO_COST }),
    /with no note/,
  );
  store.close();
});

test('a run cannot finish before it started', () => {
  const store = ScanStore.memory();
  const runId = store.openRun({
    database: DB,
    scope: scope(),
    startedAt: '2026-08-21T10:00:00Z',
  });
  assert.throws(
    () =>
      store.finishRun(runId, {
        outcome: 'completed',
        cost: NO_COST,
        finishedAt: '2026-08-20T10:00:00Z',
      }),
    /before it started/,
  );
  store.close();
});

// ---- identity collisions are loud ------------------------------------------

test('two findings claiming one id in one run is an error, not a silent overwrite', () => {
  const store = ScanStore.memory();
  const runId = store.openRun({ database: DB, scope: scope() });
  assert.throws(
    () => store.recordFindings(runId, [finding(), finding({ severity: 'low' })]),
    /both claim the id/,
  );
  // The whole batch rolled back rather than half-landing.
  assert.equal(store.findingsOf(runId).length, 0);
  store.close();
});

// ---- negative claims -------------------------------------------------------

test('a negative claim keeps its boundary', () => {
  const store = ScanStore.memory();
  const runId = store.openRun({ database: DB, scope: scope() });

  const negative = finding({
    id: 'layer-a/none',
    kind: 'negative',
    confidence: 'certain',
    severity: 'info',
    evidence: null,
    boundary: 'looked at 12 declared constraints in public; data rules were not run',
  } as Partial<Finding>);

  store.recordFindings(runId, [negative]);
  const read = store.findingsOf(runId)[0]?.finding;
  assert.equal(read?.kind, 'negative');
  assert.equal(
    read?.kind === 'negative' ? read.boundary : null,
    'looked at 12 declared constraints in public; data rules were not run',
  );
  store.close();
});

// ---- what lands on disk ----------------------------------------------------

test('sample values are dropped unless asked for, and the run says which', () => {
  const store = ScanStore.memory();

  const withSample = finding({
    evidence: {
      sql: 'SELECT id FROM damaged_rental_note LIMIT 5',
      rowCount: 3,
      sampleSize: 3,
      durationMs: 1,
      sample: [{ orphan_value: '<number>' }],
    },
  });

  const quiet = store.openRun({ database: DB, scope: scope() });
  store.recordFindings(quiet, [withSample]);
  assert.equal(store.runById(quiet)?.samplesStored, false);
  assert.deepEqual(store.findingsOf(quiet)[0]?.finding.evidence?.sample, []);

  const keeping = store.openRun({ database: DB, scope: scope(), storeSamples: true });
  store.recordFindings(keeping, [withSample]);
  assert.equal(store.runById(keeping)?.samplesStored, true);
  assert.deepEqual(store.findingsOf(keeping)[0]?.finding.evidence?.sample, [
    { orphan_value: '<number>' },
  ]);

  store.close();
});

test('a real column value is refused even when samples are turned on', () => {
  const store = ScanStore.memory();
  const runId = store.openRun({ database: DB, scope: scope(), storeSamples: true });

  const leaky = finding({
    evidence: {
      sql: 'SELECT email FROM customer LIMIT 1',
      rowCount: 1,
      sampleSize: 1,
      durationMs: 1,
      sample: [{ email: 'ana@example.com' }],
    },
  });

  assert.throws(() => store.recordFindings(runId, [leaky]), /did not come from redactCell/);
  assert.equal(store.findingsOf(runId).length, 0);
  store.close();
});

test('nothing that unlocks the database is written to the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledar-store-'));
  const file = join(dir, 'history.db');
  after(() => rmSync(dir, { recursive: true, force: true }));

  const store = ScanStore.open(file);
  const runId = store.openRun({
    database: { host: 'db.internal.example', port: 6543, database: 'pagila' },
    scope: scope(),
  });
  store.recordFindings(runId, [finding()]);
  store.finishRun(runId, { outcome: 'completed', cost: NO_COST });
  store.close();

  const bytes = readFileSync(file, 'latin1');
  assert.doesNotMatch(bytes, /db\.internal\.example/, 'the host reached the file');
  assert.doesNotMatch(bytes, /6543/, 'the port reached the file');
  assert.doesNotMatch(bytes, /fixture_no_real_data/, 'a password reached the file');
  // The things a report has to name are still there.
  assert.match(bytes, /damaged_rental_note/);
});

test('a history file is reopened, not restarted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledar-store-'));
  const file = join(dir, 'history.db');
  after(() => rmSync(dir, { recursive: true, force: true }));

  const first = ScanStore.open(file);
  const runId = first.openRun({ database: DB, scope: scope(), startedAt: '2026-08-01T00:00:00Z' });
  first.recordFindings(runId, [finding()]);
  first.finishRun(runId, { outcome: 'completed', cost: NO_COST, finishedAt: '2026-08-01T00:01:00Z' });
  first.close();

  const again = ScanStore.open(file);
  const runs = again.runsFor(DB);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.findingCount, 1);
  assert.equal(again.historyOf(DB, finding().id).length, 1);
  again.close();
});

// ---- the denominator this file is allowed not to know ----------------------
//
// `Coverage.eligible` became nullable in @ledar/contracts so a rule that
// cannot work out its own denominator can say so instead of writing 0. This
// table declared the column NOT NULL, which meant the one finding that
// admitted ignorance was the one finding that could not be stored — and the
// obvious repair, writing 0, is the exact substitution the nullable type
// exists to prevent.

test('a finding that does not know its denominator survives the round trip', () => {
  const store = ScanStore.memory();

  const runId = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-21T10:00:00Z' });
  store.recordFindings(runId, [
    finding({ coverage: coverageOf(3, null) }),
  ]);
  // `finishedAt` given rather than defaulted. The shared fixture starts a run
  // at 10:00Z on today's date, so a defaulted finish reads the wall clock and
  // lands *before* the start for the first hours of any UTC day — the test
  // would then pass or fail depending on what time it was run.
  store.finishRun(runId, {
    outcome: 'completed',
    cost: NO_COST,
    finishedAt: '2026-08-21T10:00:30Z',
  });

  const back = store.findingsOf(runId);
  assert.equal(back.length, 1);
  assert.equal(
    back[0]?.finding.coverage.eligible,
    null,
    'the unknown denominator came back as something other than null — if it ' +
      'came back as 0, "I could not tell how many applied" is now on record ' +
      'as "none applied"',
  );
  assert.equal(back[0]?.finding.coverage.checked, 3);
  store.close();
});

test('a negative claim with no denominator is refused by the file itself', () => {
  const store = ScanStore.memory();

  const runId = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-21T10:00:00Z' });

  // sealFindings already refuses this at the pack boundary. The same rule is
  // in the DDL because a finding can reach this file from somewhere that was
  // never compiled against the contract — an older release, a hand-edited
  // export — and "nothing found" with no denominator is the one sentence
  // that must never be storable.
  assert.throws(
    () =>
      store.recordFindings(runId, [
        finding({
          id: 'layer-a/none',
          kind: 'negative',
          boundary: 'Checked what could be reached.',
          evidence: null,
          coverage: coverageOf(0, null),
        }),
      ]),
    /CHECK constraint failed|constraint/i,
  );

  store.close();
});

// ---- provenance: what the claim carries about itself ------------------------
//
// `_doc/05` §7 puts these six fields on the claim rather than on the run, and
// a history file is where that stops being a preference. A run row says what
// the scan was. A finding read back six months later is read alone, and
// everything the scan knew about how it was measured is gone unless the row
// holds it.

test('all six provenance fields survive the round trip', () => {
  const store = ScanStore.memory();
  const runId = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-21T10:00:00Z' });
  store.recordFindings(runId, [finding()]);

  const back = store.findingsOf(runId)[0]?.finding;
  assert.ok(back);
  assert.equal(back.origin, 'counted');
  assert.equal(back.confidenceBasis, 'full_count');
  assert.equal(back.egressClass, 'customer-system-metadata');
  assert.equal(back.observedAt, '2026-08-21T10:00:04.000Z');
  assert.equal(back.engineRuleVersion, 'layer-a@2.1.0');
  assert.equal(back.userStatus, 'unreviewed');
  store.close();
});

test('the claim keeps its own moment, not the run’s', () => {
  // A scan of 374 tables takes long enough for the database to change
  // underneath it. A count taken at the start and one taken at the end are
  // statements about two different databases, and the run has only one clock.
  const store = ScanStore.memory();
  const runId = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-21T10:00:00Z' });
  store.recordFindings(runId, [
    finding({ id: 'a', observedAt: '2026-08-21T10:00:04.000Z' } as Partial<Finding>),
    finding({ id: 'b', observedAt: '2026-08-21T10:00:31.000Z' } as Partial<Finding>),
  ]);

  const observed = store.findingsOf(runId).map((s) => s.finding.observedAt);
  assert.deepEqual(observed, ['2026-08-21T10:00:04.000Z', '2026-08-21T10:00:31.000Z']);
  // And neither of them silently became the run's start time.
  assert.ok(!observed.includes('2026-08-21T10:00:00.000Z'));
  store.close();
});

test('a finding with no origin is refused, and told why', () => {
  const store = ScanStore.memory();
  const runId = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-21T10:00:00Z' });

  const anonymous = finding() as Partial<Finding>;
  delete anonymous.origin;

  assert.throws(
    () => store.recordFindings(runId, [anonymous as Finding]),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      // Not the raw SQLite sentence. `node:sqlite` would have said
      // "Provided value cannot be bound to SQLite parameter 12", which names
      // neither the field nor the finding; the person reading this is
      // deciding whether their rule or this file is wrong.
      assert.doesNotMatch(err.message, /SQLite parameter/);
      assert.match(err.message, /arrived without a usable `origin`/);
      assert.match(err.message, /Layer B guess and a Layer A count/);
      return true;
    },
  );
  assert.equal(store.findingsOf(runId).length, 0, 'a half-written finding landed');
  store.close();
});

test('every one of the six is required, not just the first', () => {
  // The trap this catches: a guard written for `origin` alone, with the other
  // five defaulting to whatever SQLite makes of `undefined`. Each field is
  // deleted on its own so a single missing NOT NULL cannot hide behind the
  // others.
  const fields: readonly (keyof Finding)[] = [
    'origin',
    'confidenceBasis',
    'egressClass',
    'observedAt',
    'engineRuleVersion',
    'userStatus',
  ];
  assert.equal(fields.length, 6);

  for (const field of fields) {
    const store = ScanStore.memory();
    const runId = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-21T10:00:00Z' });

    const incomplete = finding() as Partial<Finding>;
    delete incomplete[field];

    assert.throws(
      () => store.recordFindings(runId, [incomplete as Finding]),
      new RegExp(`arrived without a usable \`${field}\``),
      `a finding with no ${field} was stored anyway`,
    );
    assert.equal(store.findingsOf(runId).length, 0);

    // Blank is missing too. `origin: "  "` passes every presence check and
    // says nothing, which is the failure `saying()` in the contract exists to
    // stop and which a NOT NULL column would wave straight through.
    const blank = finding() as unknown as Record<string, unknown>;
    blank[field] = '   ';
    assert.throws(
      () => store.recordFindings(runId, [blank as unknown as Finding]),
      new RegExp(`arrived without a usable \`${field}\``),
      `a blank ${field} was stored anyway`,
    );
    assert.equal(store.findingsOf(runId).length, 0);
    store.close();
  }
});

// ---- the rule rewrite that is not a database change ------------------------
//
// The question this file could not answer before: a finding whose severity
// moved between two scans — did the database change, or did we rewrite the
// rule? Folding `engineRuleVersion` into the structure hash would have made
// every finding read as changed after any release. Leaving it out entirely
// would have left the diff blaming the customer. It is stored beside the hash,
// which is the only arrangement where both cases can be told apart.

test('a rule rewrite does not by itself move the structure hash', () => {
  const store = ScanStore.memory();

  const first = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-01T00:00:00Z' });
  store.recordFindings(first, [finding()]);
  store.finishRun(first, { outcome: 'completed', cost: NO_COST, finishedAt: '2026-08-01T00:01:00Z' });

  const second = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-15T00:00:00Z' });
  store.recordFindings(second, [
    finding({ engineRuleVersion: 'layer-a@3.0.0' } as Partial<Finding>),
  ]);
  store.finishRun(second, { outcome: 'completed', cost: NO_COST, finishedAt: '2026-08-15T00:01:00Z' });

  const [now, before] = store.historyOf(DB, finding().id);
  assert.ok(now && before);

  // ① The versions really did differ, or the equality below proves nothing.
  assert.notEqual(now.engineRuleVersion, before.engineRuleVersion);
  assert.equal(now.engineRuleVersion, 'layer-a@3.0.0');

  // ② And a version bump on its own did not make the finding look changed.
  assert.equal(
    now.structureHash,
    before.structureHash,
    'upgrading the engine made an unchanged finding read as changed — every ' +
      'finding in the file would do the same on the first scan after a release',
  );
});

test('a verdict change and a rule rewrite are two readable cases, not one', () => {
  const store = ScanStore.memory();

  const first = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-01T00:00:00Z' });
  store.recordFindings(first, [finding()]);
  store.finishRun(first, { outcome: 'completed', cost: NO_COST, finishedAt: '2026-08-01T00:01:00Z' });

  // Severity moved AND the rule was rewritten. Before the version column, this
  // was indistinguishable from the database having changed.
  const second = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-15T00:00:00Z' });
  store.recordFindings(second, [
    finding({ severity: 'low', engineRuleVersion: 'layer-a@3.0.0' } as Partial<Finding>),
  ]);
  store.finishRun(second, { outcome: 'completed', cost: NO_COST, finishedAt: '2026-08-15T00:01:00Z' });

  const [now, before] = store.historyOf(DB, finding().id);
  assert.ok(now && before);
  assert.notEqual(now.structureHash, before.structureHash);
  assert.notEqual(now.engineRuleVersion, before.engineRuleVersion);
  store.close();
});

test('a guess that became a measurement is a verdict change', () => {
  // The arc this product sells: Layer B noticed two names that looked alike,
  // then something counted the rows. Same rule, same table, same columns. If
  // `origin` were outside the structure hash this would read as *nothing
  // changed*, which is the one reading that is definitely wrong.
  const store = ScanStore.memory();

  const first = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-01T00:00:00Z' });
  store.recordFindings(first, [
    finding({
      confidence: 'unconfirmed',
      origin: 'name_pattern',
      confidenceBasis: 'name_similarity',
    } as Partial<Finding>),
  ]);
  store.finishRun(first, { outcome: 'completed', cost: NO_COST, finishedAt: '2026-08-01T00:01:00Z' });

  const second = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-15T00:00:00Z' });
  store.recordFindings(second, [
    finding({
      confidence: 'unconfirmed',
      origin: 'sampled',
      confidenceBasis: 'sample_extrapolation',
    } as Partial<Finding>),
  ]);
  store.finishRun(second, { outcome: 'completed', cost: NO_COST, finishedAt: '2026-08-15T00:01:00Z' });

  const [now, before] = store.historyOf(DB, finding().id);
  assert.ok(now && before);
  // ① Confidence held still, so nothing already in the hash moved.
  assert.equal(now.confidence, before.confidence);
  assert.equal(now.severity, before.severity);
  // ② The hash moved anyway, because what the claim rests on moved.
  assert.notEqual(now.structureHash, before.structureHash);
  assert.equal(now.origin, 'sampled');
  assert.equal(before.origin, 'name_pattern');
  store.close();
});

test('a person answering is not the scanner changing its mind', () => {
  // `userStatus` is deliberately outside the structure hash. A user marking a
  // pattern intentional must not arrive at the diff looking like the database
  // moved — but it must still be visible, or the answer had nowhere to land.
  const store = ScanStore.memory();

  const first = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-01T00:00:00Z' });
  store.recordFindings(first, [finding()]);
  store.finishRun(first, { outcome: 'completed', cost: NO_COST, finishedAt: '2026-08-01T00:01:00Z' });

  const second = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-15T00:00:00Z' });
  store.recordFindings(second, [finding({ userStatus: 'intentional' } as Partial<Finding>)]);
  store.finishRun(second, { outcome: 'completed', cost: NO_COST, finishedAt: '2026-08-15T00:01:00Z' });

  const [now, before] = store.historyOf(DB, finding().id);
  assert.ok(now && before);
  assert.equal(now.structureHash, before.structureHash);
  assert.equal(now.userStatus, 'intentional');
  assert.equal(before.userStatus, 'unreviewed');
  store.close();
});

test('the history read carries provenance, not only the hash', () => {
  // Principle ⑫: a column nothing on the real path reads is not a column. The
  // diff is built out of `historyOf`, so every field it would need to tell a
  // rule rewrite from a data change has to come back from here.
  const store = ScanStore.memory();
  const runId = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-01T00:00:00Z' });
  store.recordFindings(runId, [finding()]);
  store.finishRun(runId, { outcome: 'completed', cost: NO_COST, finishedAt: '2026-08-01T00:01:00Z' });

  const entry = store.historyOf(DB, finding().id)[0];
  assert.ok(entry);
  assert.equal(entry.origin, 'counted');
  assert.equal(entry.confidenceBasis, 'full_count');
  assert.equal(entry.egressClass, 'customer-system-metadata');
  assert.equal(entry.observedAt, '2026-08-21T10:00:04.000Z');
  assert.equal(entry.engineRuleVersion, 'layer-a@2.1.0');
  assert.equal(entry.userStatus, 'unreviewed');
  store.close();
});

test('provenance is on the disk, not only in the object handed back', () => {
  // Read as bytes for the reason the pack test gives: an object is whatever a
  // reader assembled, and a file is what survives the process. A column that
  // was written and then reconstructed from a default would look identical
  // through `findingsOf`.
  const dir = mkdtempSync(join(tmpdir(), 'ledar-store-'));
  const file = join(dir, 'history.db');
  after(() => rmSync(dir, { recursive: true, force: true }));

  const store = ScanStore.open(file);
  const runId = store.openRun({ database: DB, scope: scope(), startedAt: '2026-08-21T10:00:00Z' });
  store.recordFindings(runId, [finding()]);
  store.finishRun(runId, {
    outcome: 'completed',
    cost: NO_COST,
    finishedAt: '2026-08-21T10:00:30Z',
  });
  store.close();

  const bytes = readFileSync(file, 'latin1');
  for (const value of [
    'counted',
    'full_count',
    'customer-system-metadata',
    '2026-08-21T10:00:04.000Z',
    'layer-a@2.1.0',
    'unreviewed',
  ]) {
    assert.ok(bytes.includes(value), `${value} never reached the file`);
  }
  // The column names are in the schema the file carries, so a later reader
  // opening this with sqlite3 and nothing else can still see what is what.
  for (const column of [
    'origin',
    'confidence_basis',
    'egress_class',
    'observed_at',
    'engine_rule_version',
    'user_status',
  ]) {
    assert.ok(bytes.includes(column), `the column ${column} is not in the file`);
  }
});

// ---- a file this build does not understand ---------------------------------

test('a history file from an older schema is refused, not written into', () => {
  // Every bump is only worth anything if this fires. 1 → 2 added six NOT NULL
  // columns; a version-1 file opened and written to would fail on the first
  // INSERT with "table finding has no column named origin" — after the scan
  // had already run, in SQLite's words rather than ours. 2 → 3 turned the
  // closed vocabularies into CHECK constraints, which SQLite cannot add to an
  // existing table, so the same wall stands for the same reason.
  //
  // The version is read from SCHEMA_VERSION rather than written in, so a bump
  // does not need this assertion edited — and cannot quietly stop matching it.
  const dir = mkdtempSync(join(tmpdir(), 'ledar-store-'));
  const file = join(dir, 'old.db');
  after(() => rmSync(dir, { recursive: true, force: true }));

  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`);
  old.prepare(`INSERT INTO store_meta (key, value) VALUES (?, ?)`).run(
    'schema_version',
    '1',
  );
  old.close();

  assert.throws(
    () => ScanStore.open(file),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /schema version 1/);
      assert.match(err.message, new RegExp(`speaks version ${SCHEMA_VERSION}`));
      // It says what to do, because the person reading it has a file they care
      // about and no migration exists.
      assert.match(err.message, /start a new one alongside it/);
      return true;
    },
  );

  // And a file this build wrote itself reopens without complaint, so the
  // refusal above is about the version and not about opening files at all.
  const fresh = join(dir, 'fresh.db');
  ScanStore.open(fresh).close();
  assert.doesNotThrow(() => ScanStore.open(fresh).close());
});

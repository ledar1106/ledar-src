/**
 * What a difference between two scans is allowed to mean.
 *
 * The bug this whole file guards against has one shape, and it is not a
 * crash: a finding is missing from the second report, the diff says "fixed",
 * and it is wrong. It is wrong when the rule did not run. It is wrong when
 * the rule ran against fewer rows. It is wrong when the rule was rewritten
 * between the two scans and no longer asks the same question. All three
 * leave *exactly* the same trace in the `finding` table as a real fix, and a
 * diff that reads only that table will be confidently wrong in all three.
 *
 * So most of what is pinned here is the hedging, not the verdict. A test that
 * only checked `verdict === 'disappeared'` would pass against an
 * implementation that told the user their database was clean.
 *
 * These snapshots are built by hand rather than read out of a file. The file
 * side is `legacy.test.ts`; this side is the reasoning, and it should be
 * possible to break the reasoning without a database anywhere in sight.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diffRuns } from '../src/diff.js';
import { STORE_VOCABULARY } from '../src/schema.js';
import type {
  RecordedFinding,
  RuleRun,
  RunSnapshot,
  SnapshotSource,
} from '../src/types.js';

const FINGERPRINT = 'a'.repeat(64);
const OTHER_FINGERPRINT = 'b'.repeat(64);
const ORPHANS = 'layer-a/unvalidated-foreign-key-has-orphans';
const IMPLICIT = 'layer-b/undeclared-reference-with-unmatched-values';
const KEY = 'layer-a/fk-orphans/public.rental.fk';

const MODERN: SnapshotSource = {
  path: 'history.db',
  schemaVersion: 3,
  recordsEngineVersion: true,
  comparableStructureHash: true,
};

const ANCIENT: SnapshotSource = {
  path: 'history.v1.db',
  schemaVersion: 1,
  recordsEngineVersion: false,
  comparableStructureHash: false,
};

function finding(over: Partial<RecordedFinding> = {}): RecordedFinding {
  return {
    runId: 1,
    findingKey: KEY,
    structureHash: 'hash-1',
    rule: ORPHANS,
    kind: 'observation',
    severity: 'high',
    confidence: 'certain',
    measuredRows: 3,
    engineRuleVersion: 'layer-a@1.0.0',
    ...over,
  };
}

type SnapOver = {
  source?: SnapshotSource;
  runId?: number;
  startedAt?: string;
  outcome?: RunSnapshot['run']['outcome'];
  outcomeNote?: string | null;
  fingerprint?: string;
  label?: string;
  role?: string;
  schemas?: string[];
  visibleTables?: number;
  totalTables?: number | null;
  costTruncated?: boolean;
  truncationNote?: string | null;
  findings?: RecordedFinding[];
  rules?: RuleRun[];
};

function snapshot(over: SnapOver = {}): RunSnapshot {
  return {
    source: over.source ?? MODERN,
    run: {
      runId: over.runId ?? 1,
      databaseId: 1,
      fingerprint: over.fingerprint ?? FINGERPRINT,
      label: over.label ?? 'pagila',
      startedAt: over.startedAt ?? '2026-08-21T00:00:00.000Z',
      finishedAt: '2026-08-21T00:00:01.000Z',
      outcome: over.outcome ?? 'completed',
      outcomeNote: over.outcomeNote ?? null,
      scope: {
        database: 'pagila',
        role: over.role ?? 'ledar_reader',
        schemas: over.schemas ?? ['public'],
        visibleTables: over.visibleTables ?? 20,
        totalTables: over.totalTables === undefined ? 20 : over.totalTables,
        grantedAt: null,
        readOnlyEnforcedByDatabase: true,
        disclosure: null,
      },
      cost: { queries: 10, totalMs: 5, rowsScanned: 100 },
      costTruncated: over.costTruncated ?? false,
      truncationNote: over.truncationNote ?? null,
      samplesStored: false,
      findingCount: (over.findings ?? []).length,
    },
    findings: over.findings ?? [],
    rules: over.rules ?? [{ rule: ORPHANS, ran: true, coverage: covered(1, 1), note: null }],
  };
}

function covered(checked: number, eligible: number) {
  return { checked, eligible, skipped: [], truncatedAt: null };
}

/** The later of two runs, so `startedAt` orders the way the argument order does. */
function later(over: SnapOver = {}): RunSnapshot {
  return snapshot({ runId: 2, startedAt: '2026-08-22T00:00:00.000Z', ...over });
}

describe('the severity order this file depends on', () => {
  it('is worst-last, and that is checked separately from membership', () => {
    // `vocabulary.test.ts` already compares this list against
    // `@ledar/contracts` — but for MEMBERSHIP, not for order. `diff.ts` ranks
    // severities by their index here, so a reordering in contracts would keep
    // every existing gate green while this file quietly decided that
    // `critical` was an improvement on `info`.
    assert.deepEqual(STORE_VOCABULARY['severity'], [
      'info',
      'low',
      'medium',
      'high',
      'critical',
    ]);
  });
});

describe('comparisons that cannot mean anything', () => {
  it('refuses two different databases', () => {
    assert.throws(
      () => diffRuns(snapshot(), later({ fingerprint: OTHER_FINGERPRINT, label: 'chinook' })),
      /different databases/,
    );
  });
});

describe('a finding that is still there', () => {
  it('reports more rows as worse, with both numbers', () => {
    const d = diffRuns(
      snapshot({ findings: [finding({ measuredRows: 3 })] }),
      later({ findings: [finding({ measuredRows: 18 })] }),
    );
    assert.equal(d.changes[0]?.verdict, 'worsened');
    assert.match(d.changes[0]!.says, /Worse: 18 rows, was 3\./);
  });

  it('reports fewer rows as better', () => {
    const d = diffRuns(
      snapshot({ findings: [finding({ measuredRows: 18 })] }),
      later({ findings: [finding({ measuredRows: 3 })] }),
    );
    assert.equal(d.changes[0]?.verdict, 'improved');
  });

  it('falls back to severity when there is no row count on either side', () => {
    const d = diffRuns(
      snapshot({ findings: [finding({ measuredRows: null, severity: 'low' })] }),
      later({ findings: [finding({ measuredRows: null, severity: 'critical' })] }),
    );
    assert.equal(d.changes[0]?.verdict, 'worsened');
    assert.match(d.changes[0]!.says, /severity critical, was low/);
  });

  it('calls a moved structure fingerprint a change of shape, not of size', () => {
    const d = diffRuns(
      snapshot({ findings: [finding({ structureHash: 'hash-1' })] }),
      later({ findings: [finding({ structureHash: 'hash-2' })] }),
    );
    assert.equal(d.changes[0]?.verdict, 'structure-changed');
  });

  it('says nothing moved when nothing moved', () => {
    const d = diffRuns(
      snapshot({ findings: [finding()] }),
      later({ findings: [finding()] }),
    );
    assert.equal(d.changes[0]?.verdict, 'unchanged');
    assert.equal(d.changes[0]?.says, 'Unchanged.');
  });
});

describe('a finding that is gone — and whether that means anything', () => {
  const gone = (rules: RuleRun[]) =>
    diffRuns(
      snapshot({
        findings: [finding()],
        rules: [{ rule: ORPHANS, ran: true, coverage: covered(5, 5), note: null }],
      }),
      later({ findings: [], rules }),
    ).changes[0]!;

  it('calls it gone when the rule ran again and covered as much', () => {
    const c = gone([{ rule: ORPHANS, ran: true, coverage: covered(5, 5), note: null }]);
    assert.equal(c.verdict, 'disappeared');
    assert.equal(c.absence, 'examined');
    assert.match(c.says, /^Gone\./);
  });

  it('refuses to call it fixed when the rule did not run', () => {
    const c = gone([{ rule: ORPHANS, ran: false, note: null }]);
    assert.equal(c.absence, 'not-examined');
    // The wording, not just the enum. A caller that prints `says` and not
    // `absence` is the likely one, and it must not read as good news.
    assert.match(c.says, /not evidence it was fixed/);
    assert.doesNotMatch(c.says, /^Gone\./);
  });

  it('refuses to call it fixed when the rule ran but checked nothing', () => {
    // The real case: pagila run 10 in history.v1.db, where layer-b reports
    // `checked 0 of 5 eligible` and its one finding vanishes from a database
    // nobody had touched in the ninety seconds since run 9.
    const c = gone([{ rule: ORPHANS, ran: true, coverage: covered(0, 5), note: null }]);
    assert.equal(c.absence, 'not-examined');
    assert.match(c.says, /not evidence it was fixed/);
  });

  it('says so when the rule covered less than it did before', () => {
    const c = gone([{ rule: ORPHANS, ran: true, coverage: covered(2, 5), note: null }]);
    assert.equal(c.absence, 'less-examined');
    assert.match(c.says, /checked 2 this time and 5 last time/);
    assert.match(c.says, /not evidence it was fixed/);
  });

  it('admits it cannot tell when neither run declared a denominator', () => {
    const c = diffRuns(
      snapshot({
        findings: [finding()],
        rules: [{ rule: ORPHANS, ran: true, note: null }],
      }),
      later({ findings: [], rules: [{ rule: ORPHANS, ran: true, note: null }] }),
    ).changes[0]!;
    assert.equal(c.absence, 'coverage-unknown');
    assert.match(c.says, /cannot be told apart/);
  });

  it('treats a rule missing from the later run as not examined', () => {
    const c = gone([]);
    assert.equal(c.absence, 'not-examined');
  });
});

describe('whether a difference can be blamed on the database', () => {
  it('says nothing extra when the rule version matched', () => {
    const d = diffRuns(
      snapshot({ findings: [finding({ measuredRows: 3 })] }),
      later({ findings: [finding({ measuredRows: 9 })] }),
    );
    assert.equal(d.changes[0]?.comparability, 'like-for-like');
    assert.equal(d.changes[0]?.says, 'Worse: 9 rows, was 3.');
  });

  it('names both rule versions when the rule itself changed', () => {
    const d = diffRuns(
      snapshot({ findings: [finding({ engineRuleVersion: 'layer-b@1.0.0', rule: IMPLICIT })],
                 rules: [{ rule: IMPLICIT, ran: true, coverage: covered(5, 5), note: null }] }),
      later({ findings: [finding({ engineRuleVersion: 'layer-b@2.1.0', rule: IMPLICIT, measuredRows: 18000 })],
              rules: [{ rule: IMPLICIT, ran: true, coverage: covered(5, 5), note: null }] }),
    );
    assert.equal(d.changes[0]?.comparability, 'rule-changed');
    assert.match(d.changes[0]!.says, /layer-b@1\.0\.0 to layer-b@2\.1\.0/);
    assert.match(d.changes[0]!.says, /may be a change to the scanner rather than to your database/);
  });

  it('says NEITHER run records it when neither does', () => {
    // Saying "the earlier run does not record it" here would send the reader
    // looking in the later one for a version string that is not there either.
    const d = diffRuns(
      snapshot({ source: ANCIENT, findings: [finding({ engineRuleVersion: null })] }),
      later({ source: ANCIENT, findings: [finding({ engineRuleVersion: null, measuredRows: 9 })] }),
    );
    assert.equal(d.changes[0]?.comparability, 'rule-version-unknown');
    assert.match(d.changes[0]!.says, /Neither run records/);
  });

  it('names the earlier run when only it is silent', () => {
    const d = diffRuns(
      snapshot({ source: ANCIENT, findings: [finding({ engineRuleVersion: null })] }),
      later({ findings: [finding({ measuredRows: 9 })] }),
    );
    assert.match(d.changes[0]!.says, /The earlier run does not record/);
  });

  it('cannot attribute a finding whose rule found nothing on the other side', () => {
    // The blind spot, pinned so it is not mistaken for a bug later:
    // `engine_rule_version` lives on findings, not on `run_rule`, so a rule
    // that reported nothing leaves no version behind for that run — which is
    // exactly the situation whenever a finding APPEARS.
    const d = diffRuns(
      snapshot({ findings: [], rules: [{ rule: ORPHANS, ran: true, coverage: covered(5, 5), note: null }] }),
      later({ findings: [finding()] }),
    );
    assert.equal(d.changes[0]?.verdict, 'appeared');
    assert.equal(d.changes[0]?.comparability, 'rule-version-unknown');
  });
});

describe('reasons the whole comparison may not hold', () => {
  it('flags a baseline that never finished', () => {
    const d = diffRuns(
      snapshot({ outcome: 'failed', outcomeNote: 'connection dropped', findings: [] }),
      later({ findings: [finding()] }),
    );
    assert.ok(d.cautions.some((c) => /ended as "failed".*connection dropped/s.test(c)));
  });

  it('flags a run that stopped short of finishing every check', () => {
    const d = diffRuns(
      snapshot({ findings: [finding()] }),
      later({ findings: [], costTruncated: true, truncationNote: 'budget spent' }),
    );
    assert.ok(d.cautions.some((c) => /stopped short.*budget spent/s.test(c)));
  });

  it('says so when the two runs are handed over backwards', () => {
    const d = diffRuns(later({ findings: [finding()] }), snapshot({ findings: [] }));
    assert.ok(d.cautions.some((c) => /reads backwards/.test(c)));
  });

  it('flags a change of role, which changes what could be seen', () => {
    const d = diffRuns(snapshot(), later({ role: 'postgres' }));
    assert.ok(d.cautions.some((c) => /different roles/.test(c)));
  });

  it('flags two runs that saw different amounts of the database', () => {
    const d = diffRuns(snapshot({ visibleTables: 20 }), later({ visibleTables: 35, totalTables: 76 }));
    assert.ok(d.cautions.some((c) => /did not see the same amount/.test(c)));
  });

  it('flags different schemas', () => {
    const d = diffRuns(snapshot(), later({ schemas: ['public', 'musicbrainz'] }));
    assert.ok(d.cautions.some((c) => /different schemas/.test(c)));
  });

  it('has nothing to say about two clean, comparable runs', () => {
    // Empty is a real answer. If this ever fails, a caution has become
    // unconditional, and an unconditional caution is one nobody reads.
    const d = diffRuns(snapshot({ findings: [finding()] }), later({ findings: [finding()] }));
    assert.deepEqual(d.cautions, []);
  });
});

describe('rules that did not do the same work in both runs', () => {
  it('distinguishes "not in the record" from "did not run"', () => {
    const d = diffRuns(
      snapshot({ rules: [] }),
      later({ rules: [{ rule: ORPHANS, ran: true, coverage: covered(5, 5), note: null }] }),
    );
    // N30 fixed a bug where layer-A rules ran and were never written to
    // history. Every run before that fix looks, to this function, like a run
    // where those rules did not execute; saying so in those words would blame
    // the database for a gap in the bookkeeping.
    assert.match(d.ruleGaps[0]!.says, /does not mention it at all/);
    assert.match(d.ruleGaps[0]!.says, /not that it did not run/);
  });

  it('says a rule did not run when the record says exactly that', () => {
    const d = diffRuns(
      snapshot({ rules: [{ rule: ORPHANS, ran: true, coverage: covered(5, 5), note: null }] }),
      later({ rules: [{ rule: ORPHANS, ran: false, note: null }] }),
    );
    assert.match(d.ruleGaps[0]!.says, /did not run this time/);
  });

  it('stays quiet about rules that did the same work', () => {
    const d = diffRuns(snapshot(), later());
    assert.deepEqual(d.ruleGaps, []);
  });
});

describe('how the report is ordered and what it carries', () => {
  it('puts what needs a decision first and unchanged last', () => {
    const other = 'layer-a/fk-orphans/public.payment.fk';
    const d = diffRuns(
      snapshot({ findings: [finding(), finding({ findingKey: other, measuredRows: 1 })] }),
      later({ findings: [finding(), finding({ findingKey: other, measuredRows: 7 })] }),
    );
    assert.deepEqual(
      d.changes.map((c) => c.verdict),
      ['worsened', 'unchanged'],
    );
  });

  it('carries the standing limits of finding identity rather than restating them', () => {
    const d = diffRuns(snapshot(), later());
    // Exported from `identity.ts` precisely so this slice prints them instead
    // of writing a second, drifting copy of the caveats.
    assert.ok(d.identityLimits.length > 0);
    assert.ok(d.identityLimits.some((l) => /renamed table/i.test(l)));
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { REDACTED_CELL, isRedactedCell, redactCell } from '@ledar/contracts';
import type { Finding } from '@ledar/contracts';

import {
  IDENTITY_LIMITS,
  REDACTED_CELL_PATTERN,
  assertNoCredentials,
  assertSampleIsRedacted,
  databaseFingerprint,
  findingKey,
  structureHash,
} from '../src/identity.js';
import { coverageOf } from '@ledar/contracts';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'layer-a/fk-orphans/public.orders.orders_customer_fkey',
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
    table: 'orders',
    columns: ['customer_id'],
    plainText: 'Three rows point at a customer that is not there.',
    technical: 'FK is NOT VALID; 3 rows have no matching parent.',
    // N50: every finding states the limit of the measurement behind it.
    boundary: 'Counted one constraint; validated constraints were not re-checked.',
    evidence: {
      sql: 'SELECT 1',
      rowCount: 3,
      sampleSize: null,
      durationMs: 1.25,
      sample: [],
    },
    coverage: coverageOf(1, 1),
    ...over,
  } as Finding;
}

test('the same database on two hosts is two databases', () => {
  const a = databaseFingerprint({ host: 'db-1.internal', port: 5432, database: 'app' });
  const b = databaseFingerprint({ host: 'db-2.internal', port: 5432, database: 'app' });
  assert.notEqual(a, b);
});

test('host casing and stray whitespace do not fork a history', () => {
  const a = databaseFingerprint({ host: 'DB.Internal', port: 5432, database: 'app' });
  const b = databaseFingerprint({ host: ' db.internal ', port: 5432, database: 'app' });
  assert.equal(a, b);
});

test('the fingerprint does not contain the host it was made from', () => {
  const fp = databaseFingerprint({
    host: 'secret-host.internal',
    port: 5432,
    database: 'app',
  });
  assert.doesNotMatch(fp, /secret-host/);
  assert.match(fp, /^[0-9a-f]{64}$/);
});

test('a DSN pasted where a host belongs is refused, not sanitised', () => {
  assert.throws(
    () =>
      databaseFingerprint({
        // Split so the source text is not itself credential-shaped; see the
        // note on PAGILA_DSN in @ledar/test-fixtures. The value is unchanged.
        host: ['postgresql://user', ':', 'hunter2', '@127.0.0.1:5432/app'].join(''),
        port: 5432,
        database: 'app',
      }),
    /connection string/,
  );
  assert.throws(() => assertNoCredentials('password=hunter2', 'label'), /connection string/);
  assert.doesNotThrow(() => assertNoCredentials('prod-eu-west', 'label'));
});

test('the finding key is the rule-scoped id, so two indexes stay apart', () => {
  const first = finding({ id: 'layer-a/invalid-index/public.slug.slug_unique', columns: [] });
  const second = finding({ id: 'layer-a/invalid-index/public.slug.slug_lower', columns: [] });
  assert.notEqual(findingKey(first), findingKey(second));
  // And the structural hash alone cannot tell them apart. This is exactly why
  // the key is the id and not a rebuild from rule+schema+table+columns.
  assert.equal(structureHash(first), structureHash(second));
});

test('a finding with no id cannot enter a history', () => {
  assert.throws(() => findingKey(finding({ id: '   ' })), /empty id/);
});

test('the structure hash ignores how many rows, not what the claim is', () => {
  const base = finding();
  const moreRows = finding({
    evidence: { sql: 'SELECT 1', rowCount: 900, sampleSize: null, durationMs: 2, sample: [] },
  });
  assert.equal(
    structureHash(base),
    structureHash(moreRows),
    'a data change must not look like a structure change',
  );

  assert.notEqual(structureHash(base), structureHash(finding({ severity: 'low' })));
  assert.notEqual(structureHash(base), structureHash(finding({ confidence: 'probable' })));
  assert.notEqual(structureHash(base), structureHash(finding({ table: 'invoices' })));
});

test('what the claim rests on is part of what the claim is', () => {
  // A pattern that became a measurement is a different claim, even when
  // confidence and severity hold still. Left out of the hash this reads as
  // *nothing changed*, which is the one reading that is definitely wrong.
  const guessed = finding({
    confidence: 'unconfirmed',
    origin: 'name_pattern',
    confidenceBasis: 'name_similarity',
  } as Partial<Finding>);
  const measured = finding({
    confidence: 'unconfirmed',
    origin: 'sampled',
    confidenceBasis: 'sample_extrapolation',
  } as Partial<Finding>);

  // ① Nothing already in the hash moved between the two.
  assert.equal(guessed.confidence, measured.confidence);
  assert.equal(guessed.severity, measured.severity);
  // ② The hash moved anyway.
  assert.notEqual(structureHash(guessed), structureHash(measured));
});

test('who produced the claim, and when, is not part of what it says', () => {
  const base = finding();

  // A release that renumbers every rule must not make every finding in the
  // file read as changed — that is failure mode four in IDENTITY_LIMITS, and
  // it would arrive on exactly the scan a user looks at most closely.
  assert.equal(
    structureHash(base),
    structureHash(finding({ engineRuleVersion: 'layer-a@9.9.9' } as Partial<Finding>)),
    'an engine upgrade made an unchanged finding look changed',
  );

  // `observedAt` moves on every scan by construction; in the hash it would
  // make every finding permanently "changed" and the hash worth nothing.
  assert.equal(
    structureHash(base),
    structureHash(finding({ observedAt: '2027-01-01T00:00:00.000Z' } as Partial<Finding>)),
  );

  // A person answering a question is not the scanner changing its mind. It is
  // visible through `historyOf`; it is not a verdict change.
  assert.equal(
    structureHash(base),
    structureHash(finding({ userStatus: 'intentional' } as Partial<Finding>)),
  );

  // ① and the fixture really did differ in those fields, or the three
  //    equalities above are green because nothing was changed at all.
  assert.notEqual(
    base.engineRuleVersion,
    finding({ engineRuleVersion: 'layer-a@9.9.9' } as Partial<Finding>).engineRuleVersion,
  );
  assert.notEqual(
    base.userStatus,
    finding({ userStatus: 'intentional' } as Partial<Finding>).userStatus,
  );
});

test('column lists that differ only in where the split falls hash differently', () => {
  const joined = finding({ columns: ['a,b'] });
  const split = finding({ columns: ['a', 'b'] });
  assert.notEqual(structureHash(joined), structureHash(split));
});

test('composite key column order is part of the identity', () => {
  const forward = finding({ columns: ['tenant_id', 'order_id'] });
  const reversed = finding({ columns: ['order_id', 'tenant_id'] });
  assert.notEqual(structureHash(forward), structureHash(reversed));
});

test('an unredacted sample value is refused before it reaches disk', () => {
  assert.throws(
    () => assertSampleIsRedacted([{ orphan_value: 'ana@example.com' }], 'f/1'),
    /did not come from redactCell/,
  );
  assert.throws(
    () => assertSampleIsRedacted([{ amount: 4200 }], 'f/1'),
    /did not come from redactCell/,
  );
  assert.doesNotThrow(() =>
    assertSampleIsRedacted([{ orphan_value: '<text:15>' }, { orphan_value: 'null' }], 'f/1'),
  );
});

test('the limits of this identity scheme are written down and not empty', () => {
  assert.ok(IDENTITY_LIMITS.length >= 6);
  for (const limit of IDENTITY_LIMITS) assert.ok(limit.trim().length > 20);
  assert.ok(IDENTITY_LIMITS.some((l) => /renamed table/i.test(l)));
  assert.ok(IDENTITY_LIMITS.some((l) => /renamed column/i.test(l)));
  assert.ok(IDENTITY_LIMITS.some((l) => /recreated under a different name/i.test(l)));
});

// ---- the duplicate that is allowed to exist, and its tripwire --------------
//
// `@ledar/store` keeps no runtime dependency on `@ledar/contracts` on purpose:
// a scan history has to be readable on a machine with nothing else installed,
// so the store cannot import the redaction rule and holds a copy of the
// pattern instead. A copied safety rule with nothing watching it is how the
// three redactors drifted apart in the first place — Layer A emitted a real
// `null` for an empty cell, Layer B emitted the string, and this guard took
// only the string. These two tests are what a shared import would have given
// for free. Test code may import whatever it likes; none of it ships.

test('the store copy of the redaction pattern still matches the contract', () => {
  assert.equal(
    REDACTED_CELL_PATTERN.source,
    REDACTED_CELL.source,
    'The store and @ledar/contracts no longer agree on what a redacted cell ' +
      'looks like. Whichever one just changed, the other has to change with ' +
      'it — a value the contract calls redacted and the store calls raw (or ' +
      'the reverse) is a scan that either refuses to record itself or records ' +
      'something it should not.',
  );
  assert.equal(REDACTED_CELL_PATTERN.flags, REDACTED_CELL.flags);
});

test('everything the shared redactor produces is accepted by the store', () => {
  const fromTheDatabase: unknown[] = [
    null,
    undefined,
    0,
    -1,
    42.5,
    '',
    'ana.nguyen@acme-holdings.example',
    '550e8400-e29b-41d4-a716-446655440000',
    { nested: 'object' },
    ['array'],
    true,
  ];

  // The producer and the guard, checked against each other rather than each
  // against a list somebody typed. A cell the redactor can emit and the store
  // will not store is a bug in one of them, and this says which pairs fail.
  for (const value of fromTheDatabase) {
    const cell = redactCell(value);
    assert.doesNotThrow(
      () => assertSampleIsRedacted([{ column: cell }], 'test/pair'),
      `redactCell(${JSON.stringify(value) ?? 'undefined'}) produced ` +
        `"${cell}", which this store refuses to write.`,
    );
  }
});

// ---- the empty cell, measured because nobody had ---------------------------
//
// Debt N15b.
//
// THIS BRANCH IS NOT ON THE LIVE PATH, AND THAT IS THE POINT. Both sample
// queries `SELECT` only the candidate columns and require every one of them to
// be `IS NOT NULL`, composite foreign keys included, so no empty cell can
// reach a sample by construction — `packs-layer-a/test/sample-query-null-
// branch.test.ts` locks that shape down. These tests exist so that the day the
// branch wakes up — somebody samples whole rows instead of the candidate
// columns — the behaviour has already been decided, instead of being
// discovered then, in whatever form it happens to have taken by that point.
//
// It is the branch worth pinning rather than any other unreachable one because
// it is exactly where the three redactors that preceded `redactCell` disagreed
// (HANDOFF-STATUS section 4, lesson 14). Two forms of empty cell still exist
// in this repo, and they are not the same value:
//
//   JS `null`       what Layer A's old `redactRow` put in a sample, and what
//                   still sits in any pack or history file written before the
//                   producers converged.
//   string 'null'   what `redactCell` produces today, for null and undefined
//                   alike.
//
// Measured 2026-08-21, and the measurement found a disagreement:
//
//                    isRedactedCell   assertSampleIsRedacted   assertPackIsRedacted
//     JS null        accepts          REFUSES                  accepts
//     string 'null'  accepts          accepts                  accepts
//
// One cell out of six. A finding whose sample held a JS null could be exported
// into an Evidence Pack and then refused by the history file — two gates
// enforcing one rule, giving different answers about the same value.
//
// Resolved the same day, in `src/`, as one decision about all three rather
// than as a test asserting whichever behaviour was convenient. The gates now
// agree, and they agree on REFUSE:
//
//                    isRedactedCell   assertSampleIsRedacted   assertPackIsRedacted
//     JS null        REFUSES          REFUSES                  REFUSES
//     string 'null'  accepts          accepts                  accepts
//
// Refuse rather than accept, because `redactCell` is the only sanctioned
// producer and it always returns a string. A bare null in a sample is not a
// harmless empty value — it is proof that something built that sample without
// going through the redactor, which is the drift these gates exist to notice.
// Accepting it would have been safe for that one cell and would have taught
// the next reader that bypassing the redactor is tolerated.
//
// The tests below now pin the agreement. They are still worth their space: the
// branch is unreachable, so nothing else would notice one of the three moving.

test('an empty cell is a shape only in the form redactCell produces', () => {
  assert.equal(isRedactedCell('null'), true, "the string 'null' was rejected");
  assert.equal(
    isRedactedCell(null),
    false,
    'a bare JS null is being called redacted again. It is not a value the ' +
      'redactor can produce, so a cell holding one skipped the redactor.',
  );

  assert.equal(REDACTED_CELL.test('null'), true);
  assert.equal(
    REDACTED_CELL_PATTERN.test('null'),
    true,
    'the store copy no longer matches the empty cell the contract produces',
  );
});

test('the raw pattern says yes to a JS null, which is why nothing uses it raw', () => {
  // Not a rule, an accident: `RegExp#test` coerces its argument to a string
  // first, so the pattern is asked about "null" rather than about null. Both
  // copies of the pattern are exported — for the tripwire above — and this is
  // the trap a caller reaching past `isRedactedCell` would fall into.
  assert.equal(REDACTED_CELL.test(null as unknown as string), true);
  assert.equal(REDACTED_CELL_PATTERN.test(null as unknown as string), true);

  assert.equal(
    isRedactedCell(null),
    false,
    'the guarded check has to disagree with the raw pattern here, or the ' +
      'string check in front of it has been dropped',
  );
});

test('the store gate takes the string and refuses the JS null', () => {
  // The form `redactCell` produces today, for null and undefined alike.
  assert.doesNotThrow(
    () => assertSampleIsRedacted([{ orphan_value: 'null' }], 'n15b/string'),
    "the store refuses the empty cell `redactCell` produces, so a sample " +
      'holding one could not be written to a history at all',
  );

  assert.throws(
    () => assertSampleIsRedacted([{ orphan_value: null }], 'n15b/js-null'),
    /bare null/,
    'the store now accepts a JS null, and the other two gates refuse it. ' +
      'Whichever one moved, all three have to move together.',
  );
});

test('all three gates give the same answer about both forms of empty cell', () => {
  const storeAccepts = (cell: unknown): boolean => {
    try {
      assertSampleIsRedacted([{ orphan_value: cell }], 'n15b/pair');
      return true;
    } catch {
      return false;
    }
  };

  // Stated as a comparison rather than as separate facts, so that one gate
  // moving shows up here as a change in the relationship — which is the thing
  // lesson 14 says nobody was watching. The export gate's own half of this is
  // in `packages/contracts/test/evidence-pack.test.ts`; it runs `isRedactedCell`
  // internally, so agreement with the contract is agreement with all three.
  const forms: readonly [string, unknown, boolean][] = [
    ["the string 'null'", 'null', true],
    ['a JS null', null, false],
  ];

  for (const [label, cell, expected] of forms) {
    assert.equal(
      isRedactedCell(cell),
      expected,
      `the contract gate changed its answer about ${label}`,
    );
    assert.equal(
      storeAccepts(cell),
      expected,
      `the store gate and the contract gate disagree about ${label}. They ` +
        `agreed on 2026-08-21 after a disagreement about exactly this, and a ` +
        `third copy in evidence-pack.ts has to move with them.`,
    );
  }
});

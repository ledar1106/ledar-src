/**
 * Layer B regression against the Pagila fixture.
 *
 * The deliberate faults in `fixture-damage.sql` that belong to Layer B pull
 * in three different directions on purpose, and each direction is a different
 * thing the rule has to be able to do:
 *
 *   damaged_invoice.customer_id      80% match  →  raised
 *   damaged_tag_link.damaged_tag_id  75% match  →  raised   (text keys)
 *   damaged_asset_link.damaged_asset 75% match  →  raised   (uuid keys)
 *   damaged_sentinel_link.…_id       19 of 20 unmatched are one value
 *                                                →  raised, on the other 1
 *   damaged_wide_link.damaged_wide_id  clean head, damaged tail
 *                                                →  raised, from a block sample
 *   damaged_external_ref.staff_id     0% match  →  ruled out, and shown
 *   damaged_convention_link.…_id     all unmatched are one value
 *                                                →  ruled out, and shown
 *   damaged_bulk_link.damaged_bulk_id  estimate lies
 *                                                →  sample came back empty,
 *                                                   and said so
 *
 * The last three are the important half of this file. A scanner is judged on
 * what it declines to claim at least as much as on what it finds, and those
 * are the ways of declining — after looking, and after looking at nothing.
 * See the comments above them before changing anything here.
 *
 * Assertions are on structure — rule id, kind, confidence, severity, counts,
 * and which of the two set-aside lists a candidate landed in — never on the
 * wording of `plainText` or of a skip reason. Layer B prose gets rewritten
 * often, and a suite that fails on rewording is a suite people stop reading.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  QueryBudget,
  qualified,
  quoteIdent,
  readSchemaGraph,
} from '@ledar/connector-postgres';
import {
  IMPLICIT_FK_RULE,
  LAYER_B_RULE_VERSION,
  findCandidates,
  runImplicitForeignKeys,
} from '@ledar/packs-layer-b';

// One shared gate for all three suites, so the DSN and the fixture table
// list cannot drift apart across copies.
import {
  FIXTURE_SCHEMA,
  announceSkip,
  openPagila,
} from '@ledar/test-fixtures';

const SUITE = 'Layer B regression against the Pagila fixture';

/**
 * Taken from what the functions return, rather than imported by name.
 *
 * The finding type in `@ledar/contracts` is being reworked while this is
 * written. This suite pins the *content* of the result — which column, how
 * many unmatched, reported or skipped — not what the type is called this
 * week, and a test that breaks on a rename is noise.
 */
type Graph = Awaited<ReturnType<typeof readSchemaGraph>>;
type Outcome = Awaited<ReturnType<typeof runImplicitForeignKeys>>;

/** The column that behaves like a foreign key and has five broken links. */
const REAL = {
  table: 'damaged_invoice',
  column: 'customer_id',
  parent: 'customer',
  orphans: 5,
  sampled: 25,
} as const;

/** The column whose name matches a table and whose values match nothing. */
const TRAP = {
  table: 'damaged_external_ref',
  column: 'staff_id',
  parent: 'staff',
} as const;

/**
 * Damage 9: the candidate the rule is supposed to leave alone.
 *
 * Debt N2 in HANDOFF-STATUS.md section 1c. `runImplicitForeignKeys` files a
 * candidate under `cause: 'table_too_large'` when the child table's estimated
 * size is over its threshold, and Pagila has no table near that size, so the
 * branch — and the "did not check" group the CLI prints out of it — had never
 * run outside a unit test. Nobody had seen the sentence.
 *
 * The fixture does not hold nine hundred thousand rows. It holds twelve, and
 * an overstated `pg_class.reltuples`, which is the exact number
 * `readSchemaGraph` reads into `estimatedRows` — the same move damage 5 makes
 * with `pg_index.indisvalid`. The estimate is not written down here either:
 * it is read back out of the catalog at run time and compared, so this suite
 * cannot drift away from the fixture without saying so.
 */
const TOO_LARGE = {
  table: 'damaged_bulk_link',
  column: 'damaged_bulk_id',
  parent: 'damaged_bulk',
} as const;

const TOO_LARGE_TARGET = `${FIXTURE_SCHEMA}.${TOO_LARGE.table}.${TOO_LARGE.column}`;

/**
 * Damage 10: a repeated value hiding one genuine orphan behind it.
 *
 * Debt N33. 80 rows match, 19 carry the same value, 1 is a real orphan. The
 * rule must report 1 — not 20, which is the RubyGems false positive, and not
 * 0, which is what a cruder fix does when it rules the whole column out on
 * sight.
 */
const SENTINEL = {
  table: 'damaged_sentinel_link',
  column: 'damaged_sentinel_id',
  rows: 100,
  /** Everything that matches nothing: the repeated value plus the real one. */
  unmatched: 20,
  /** The repeated value's share of that. */
  sentinel: 19,
  /** What should survive being set aside. */
  residual: 1,
} as const;

/** Damage 11: the same convention with nothing behind it. */
const CONVENTION = {
  table: 'damaged_convention_link',
  column: 'damaged_convention_id',
} as const;

const CONVENTION_TARGET = `${FIXTURE_SCHEMA}.${CONVENTION.table}.${CONVENTION.column}`;

/**
 * Damage 14: one unmatched row, which is not a convention.
 *
 * Debt N38. The sentinel rule reads a value covering >= 80% of the unmatched
 * set as a convention, and that has a hole at the bottom that is pure
 * arithmetic: with exactly ONE unmatched row the dominant value covers 100%
 * of the set and clears the bar without any repetition existing at all.
 *
 * Found by measuring, not by imagining — every Layer B candidate on six
 * benches. `se_dba.posts.owner_user_id`: 242,133 rows, one unmatched, 100.0%
 * dominance, and its single broken link disappeared into `ruledOut` under a
 * reason that was untrue of it.
 */
const LONELY = {
  table: 'damaged_lonely_link',
  column: 'damaged_lonely_id',
  rows: 100,
  orphans: 1,
} as const;

const LONELY_TARGET = `${FIXTURE_SCHEMA}.${LONELY.table}.${LONELY.column}`;

/**
 * Damage 12: the fault that lives only where the old sampler never looked.
 *
 * Debt N34. 42,000 clean rows, then 18,000 unmatched ones, in that physical
 * order. `LIMIT 10000` with no `ORDER BY` reads the clean head and reports
 * nothing at all. 60,000 clears EXACT_BELOW_ROWS, so this is the only fixture
 * that exercises the sampled path with rows in it.
 */
const WIDE = {
  table: 'damaged_wide_link',
  column: 'damaged_wide_id',
  parent: 'damaged_wide',
  rows: 60_000,
  orphanShare: '30%',
} as const;

/**
 * Damage 6 and 7: the same broken reference in two value shapes.
 *
 * Debt N15 in HANDOFF-STATUS.md section 1c. `redactCell` can produce
 * `<number>`, `<text:N>`, `<uuid>` and `'null'`, and until these two tables
 * existed only `<number>` had ever been produced from a value that came out
 * of Postgres — every orphan column in the fixture held integers. Three
 * copies of that function once agreed on everything except the branch no
 * query could reach, so the branches that can be reached are reached here,
 * on real rows, rather than on values somebody typed into a unit test.
 *
 * The two also pin the two conventions `parentNameGuesses` understands, and
 * the pinning matters as much as the shapes: the bare form went unread for
 * the whole of MusicBrainz, and the rule reported "nothing stood out" across
 * 374 tables with total confidence.
 *
 *   damaged_tag_id    → damaged_tag     suffix form, text keys
 *   damaged_asset     → damaged_asset   bare form, uuid keys
 *
 * `rows` is larger than `sampled` on purpose. The difference is the two
 * empty cells in each table — see the tripwire note below.
 */
const SHAPED = [
  {
    table: 'damaged_tag_link',
    column: 'damaged_tag_id',
    parent: 'damaged_tag',
    orphans: 3,
    sampled: 12,
    rows: 14,
    shape: /^<text:\d+>$/,
    shapeName: '<text:N>',
  },
  {
    table: 'damaged_asset_link',
    column: 'damaged_asset',
    parent: 'damaged_asset',
    orphans: 3,
    sampled: 12,
    rows: 14,
    shape: /^<uuid>$/,
    shapeName: '<uuid>',
  },
] as const;

const TRAP_TARGET = `${FIXTURE_SCHEMA}.${TRAP.table}.${TRAP.column}`;

const gate = await openPagila();

if (!gate.ok) {
  announceSkip(SUITE, gate.reason);

  // Registered as a skipped test rather than a skipped suite, so it lands in
  // the runner's "skipped" tally. A suite that disappears from the totals
  // reads as "nothing to do here"; a skipped test reads as a hole.
  describe(SUITE, () => {
    it('the two Layer B faults were not measured', { skip: gate.reason }, () => {
      assert.fail('unreachable: this test is skipped');
    });
  });
} else {
  const client = gate.client;

  let graph: Graph;
  let outcome: Outcome;

  /**
   * The window every `observedAt` has to land inside.
   *
   * "Is it a parseable date" is satisfied by any constant somebody typed into
   * the source, and a constant is exactly the thing this field exists to rule
   * out. Bracketing the run makes it a statement about when the claim was
   * measured.
   */
  let runStartedAt = 0;
  let runFinishedAt = 0;

  describe(SUITE, () => {
    before(async () => {
      graph = await readSchemaGraph(client, [FIXTURE_SCHEMA]);
      assert.ok(
        graph.tables.length > 0,
        `no readable tables in ${FIXTURE_SCHEMA} — the role cannot see the fixture`,
      );

      // Full budget, not the half-share the CLI gives each layer. Anything
      // missing from the result has to mean the rule did not see it, not
      // that the scan ran out of room before it got there.
      runStartedAt = Date.now();
      outcome = await runImplicitForeignKeys(client, graph, new QueryBudget());
      runFinishedAt = Date.now();
    });

    after(async () => {
      await client.end();
    });

    it('spends its whole run without hitting a ceiling', () => {
      // This underwrites every other assertion in the file. If the budget
      // were exhausted, "not reported" would be ambiguous — cut short, or
      // rejected on the merits? — and the anti-false-positive check below
      // would be measuring nothing.
      assert.equal(
        outcome.budgetExhausted,
        false,
        'the budget ran out; a missing finding can no longer be told apart ' +
          'from a finding that was never checked',
      );
    });

    // ── fault 4: the reference that is real ──────────────────────────────
    it(`${REAL.table}.${REAL.column}: ${REAL.orphans} of ${REAL.sampled} unmatched, 80% match`, () => {
      const hits = outcome.findings.filter((f) => f.table === REAL.table);
      assert.equal(
        hits.length,
        1,
        `expected one finding on ${REAL.table}, got ${hits.length}. Layer B ` +
          `reported: ` +
          (outcome.findings.length === 0
            ? '(nothing at all)'
            : outcome.findings.map((f) => `${f.table}.${f.columns[0]}`).join(', ')),
      );

      const f = hits[0]!;
      assert.equal(f.rule, 'layer-b/undeclared-reference-with-unmatched-values');

      // Layer B observes a pattern; it does not get to call it a defect.
      // These three fields are the whole difference between this product and
      // a linter that shouts.
      assert.equal(f.kind, 'inference');
      assert.equal(f.confidence, 'unconfirmed');
      assert.equal(f.severity, 'medium');

      assert.equal(f.schema, FIXTURE_SCHEMA);
      assert.deepEqual(f.columns, [REAL.column]);

      assert.ok(f.evidence, 'a count with no query behind it is not evidence');
      assert.equal(f.evidence.rowCount, REAL.orphans);
      assert.equal(f.coverage.truncatedAt, null);

      // 25 rows is under EXACT_BELOW_ROWS, so every non-null value was read
      // and the denominator is the whole column rather than a draw from it.
      // The published query is where that is legible to a machine: no
      // TABLESAMPLE clause means nothing was sampled.
      assert.equal(f.evidence.sampleSize, REAL.sampled);
      assert.ok(
        !f.evidence.sql.includes('TABLESAMPLE'),
        `the query behind ${f.id} samples a ${REAL.sampled}-row table. Under ` +
          `EXACT_BELOW_ROWS every value is supposed to be read, and a sampled ` +
          `answer here would be an estimate wearing the words of a count.`,
      );

      // 20 of 25 values line up. Derived from the two numbers above rather
      // than read out of the sentence, because the sentence is prose.
      const matchRate = (f.evidence.sampleSize - f.evidence.rowCount) / f.evidence.sampleSize;
      assert.equal(matchRate, 0.8);
    });

    // ── fault 5: THE TRAP ────────────────────────────────────────────────
    //
    // This is the check that matters more than the other four together, and
    // it is the one most likely to be quietly broken by a well-meaning
    // change to the matching rule.
    //
    // damaged_external_ref.staff_id is named exactly like a foreign key.
    // Pagila has a `staff` table with an integer primary key, so the name
    // and the type both line up. Everything a name-based heuristic looks at
    // says "this points at staff".
    //
    // It does not. The values are IDs from some other system entirely, and
    // not one of the thirty matches. The column is a coincidence.
    //
    // A scanner that raises this is not being thorough, it is being wrong —
    // and it is wrong in the way that ends the product. The person reading
    // the report cannot check it: they do not read SQL, that is why the tool
    // exists. They can only decide whether to believe it. One confident
    // alarm about a column that was never broken teaches them that the
    // confident half of the report is guesswork too, and after that the real
    // findings get skimmed past as well.
    //
    // So the requirement is in four parts, and all four are asserted:
    //
    //   1. The column WAS considered. Not raising it because the heuristic
    //      went blind to it is not the same as rejecting it — that would
    //      pass this test for the wrong reason, and would go on passing
    //      after the rule stopped working at all.
    //   2. It is NOT in `findings`. Nothing is claimed about it.
    //   3. It IS in `ruledOut`, with a reason. Silence is not honesty; the
    //      report has to be able to say what it looked at and let go.
    //   4. It is NOT in `notExamined`. This one used to be impossible to
    //      state: both kinds shared a single `skipped` array, so a target
    //      the rule had queried and dismissed was filed beside targets it
    //      had never opened. That made `checked + skipped` exceed
    //      `eligible` — the fraction `sealFindings` refuses — and printed
    //      this column under "did not check" directly above the count that
    //      proves it was checked.
    //
    describe(`${TRAP.table}.${TRAP.column}: the false-positive trap`, () => {
      it('is considered as a candidate — the heuristic is not blind to it', () => {
        const candidates = findCandidates(graph);
        const seen = candidates.find(
          (c) => c.childTable === TRAP.table && c.childColumn === TRAP.column,
        );

        assert.ok(
          seen,
          `${TRAP_TARGET} was never proposed as a candidate. The rule is not ` +
            `rejecting it — it cannot see it. Any "not reported" result below ` +
            `is meaningless while this is true.`,
        );
        assert.equal(seen.parentTable, TRAP.parent);
        assert.equal(seen.parentSchema, FIXTURE_SCHEMA);
      });

      it('is NOT reported as a finding', () => {
        const leaked = outcome.findings.filter(
          (f) => f.table === TRAP.table || f.columns.includes(TRAP.column),
        );

        assert.deepEqual(
          leaked.map((f) => f.id),
          [],
          `Layer B raised a finding about ${TRAP_TARGET}. Its values match ` +
            `${TRAP.parent} 0% of the time — the name is a coincidence. ` +
            `Reporting it is a false positive, and a false positive here ` +
            `costs the credibility of every true finding in the report.`,
        );
      });

      it('IS listed as checked and ruled out, with a reason', () => {
        const entry = outcome.ruledOut.find((s) => s.target === TRAP_TARGET);

        assert.ok(
          entry,
          `${TRAP_TARGET} is neither reported nor ruled out — it vanished. ` +
            `Ruled out: ${outcome.ruledOut.map((s) => s.target).join(', ') || '(empty)'}. ` +
            `Not examined: ${outcome.notExamined.map((s) => s.target).join(', ') || '(empty)'}.`,
        );
        assert.ok(
          entry.reason.trim().length > 0,
          `${TRAP_TARGET} was set aside with an empty reason. A scan that ` +
            `drops a check without saying why produces a report ` +
            `indistinguishable from a complete one.`,
        );

        // The label, not the prose. The reason sentence is rewritten freely;
        // the cause is set at the push site and is what a report groups on.
        assert.equal(
          entry.cause,
          'match_rate_too_low',
          `${TRAP_TARGET} was ruled out for "${entry.cause}". The trap has to ` +
            `be let go because its values did not line up — any other cause ` +
            `means this suite is passing for a reason it did not intend.`,
        );
      });

      it('was rejected on its values, not because the scan ran out of room', () => {
        // "Not raised" can come from two very different places: the match
        // rate said no, or the rule never got to ask. Only the first is the
        // behaviour under test, and the two used to be indistinguishable
        // from outside because both landed in one `skipped` array.
        assert.equal(outcome.budgetExhausted, false);

        const unseen = outcome.notExamined.find((s) => s.target === TRAP_TARGET);
        assert.equal(
          unseen,
          undefined,
          `${TRAP_TARGET} is filed as never examined (${unseen?.cause}). ` +
            `Then nothing here measures restraint: an unasked question and a ` +
            `question answered "no" leave the same silence in the findings.`,
        );

        // `candidatesVerified` counts successful match queries. The trap and
        // the real reference both have to be among them.
        assert.ok(
          outcome.candidatesVerified >= 2,
          `only ${outcome.candidatesVerified} candidate(s) were actually ` +
            `queried; ${TRAP_TARGET} and ${REAL.table}.${REAL.column} both ` +
            `have to be measured against real values for this suite to mean ` +
            `anything`,
        );
      });
    });

    // ── damage 9: the candidate that was never opened ────────────────────
    //
    // The other way of not raising something, and the one that had never
    // happened on a real database. The trap above was queried and let go;
    // this one is set aside before any query is built, because checking it
    // would be a cost the scan is not entitled to spend without asking.
    //
    // Both look identical in the findings list — nothing there either way —
    // and the whole point of `notExamined` is that they must not look
    // identical in the report. So the parts are asserted separately:
    //
    //   1. The column WAS proposed as a candidate. If the heuristic cannot
    //      see it, nothing below means anything: an unexamined candidate and
    //      an unseen column leave the same silence.
    //   2. Its estimate is the one the catalog holds. This is what ties the
    //      assertion to the fixture's sabotage rather than to a number typed
    //      in here, and it is what fails loudly on the day somebody runs
    //      ANALYZE on that table and heals the fault by accident.
    //   3. It is NOT a finding. A table nobody looked inside cannot produce
    //      a claim about its contents.
    //   4. It IS in `notExamined`, with `cause: 'table_too_large'`.
    //   5. It is NOT in `ruledOut`. Ruled out means measured and dismissed;
    //      filing an unopened table there would be the scan taking credit
    //      for work it declined to do, which is the exact confusion the two
    //      lists were split apart to end.
    describe(`${TOO_LARGE.table}.${TOO_LARGE.column}: the sample that came back empty`, () => {
      it('is considered as a candidate, carrying the estimate the catalog holds', async () => {
        const seen = findCandidates(graph).find(
          (c) => c.childTable === TOO_LARGE.table && c.childColumn === TOO_LARGE.column,
        );

        assert.ok(
          seen,
          `${TOO_LARGE_TARGET} was never proposed as a candidate. The rule is ` +
            `not setting it aside — it cannot see it, so "not examined" below ` +
            `would be true for a reason this suite is not testing.`,
        );
        assert.equal(seen.parentTable, TOO_LARGE.parent);
        assert.equal(seen.parentSchema, FIXTURE_SCHEMA);

        // Read back from pg_class rather than written down here. The fixture
        // overstates `reltuples` on that one table and `readSchemaGraph`
        // reads exactly that column into `estimatedRows`, so this equality is
        // what connects the damage to the branch it is meant to trip. It also
        // fails the moment anyone runs ANALYZE on the table — which silently
        // repairs the fault and would otherwise leave the tests below failing
        // with no visible cause.
        const res = await client.query(
          `SELECT c.reltuples::bigint AS estimated FROM pg_class c WHERE c.oid = $1::regclass`,
          [qualified(FIXTURE_SCHEMA, TOO_LARGE.table)],
        );
        const fromCatalog = Number(res.rows[0]?.estimated);

        assert.ok(
          fromCatalog > 0,
          `pg_class says ${TOO_LARGE.table} has an estimate of ${fromCatalog}. ` +
            `A negative value is Postgres's "never analysed" sentinel and a ` +
            `small one means something re-analysed the table, which puts it ` +
            `back under the size gate and disarms damage 9. Reload ` +
            `packages/packs-layer-a/test/fixture-damage.sql, and do not run ` +
            `ANALYZE on that table.`,
        );
        assert.equal(
          seen.childRowsEstimated,
          fromCatalog,
          `the candidate carries ${seen.childRowsEstimated} rows and the ` +
            `catalog says ${fromCatalog}. The size decision is then being made ` +
            `on a number that did not come from the database.`,
        );
      });

      it('is NOT reported as a finding', () => {
        const leaked = outcome.findings.filter(
          (f) => f.table === TOO_LARGE.table || f.columns.includes(TOO_LARGE.column),
        );

        assert.deepEqual(
          leaked.map((f) => f.id),
          [],
          `Layer B raised a finding about ${TOO_LARGE_TARGET}. A query ran, but ` +
            `it drew no rows, so there is nothing it could honestly claim about ` +
            `the values in it.`,
        );
      });

      it('the empty draw is not counted as a column that was checked', () => {
        // The bug this catches was real and arrived with sampling. `verified`
        // was incremented as soon as the query resolved, and the empty draw
        // was ALSO pushed to `notExamined` — so one column was counted in
        // both, and the rule published `12 checked and 1 not checked out of
        // 12 eligible`. `sealFindings` refused the whole batch, which is the
        // gate working; this is the assertion that stops it getting that far.
        const rule = outcome.rules.find((r) => r.rule === IMPLICIT_FK_RULE);
        assert.ok(rule);
        assert.equal(
          rule.checked + rule.notChecked,
          rule.eligible,
          `${rule.checked} checked + ${rule.notChecked} not checked does not ` +
            `equal ${rule.eligible} eligible. A query that came back with no ` +
            `rows costs the database something and teaches nothing — it is ` +
            `budget spent, not a target checked.`,
        );
      });

      it('IS listed as never examined, because the sample was empty', () => {
        const entry = outcome.notExamined.find((s) => s.target === TOO_LARGE_TARGET);

        assert.ok(
          entry,
          `${TOO_LARGE_TARGET} is neither reported nor listed as unexamined — ` +
            `it vanished, and the coverage hole it represents is invisible. ` +
            `Not examined: ${outcome.notExamined.map((s) => s.target).join(', ') || '(empty)'}. ` +
            `Ruled out: ${outcome.ruledOut.map((s) => s.target).join(', ') || '(empty)'}.`,
        );
        assert.ok(
          entry.reason.trim().length > 0,
          `${TOO_LARGE_TARGET} was set aside with an empty reason. A gap with ` +
            `no explanation reads as an oversight, and the reader cannot tell ` +
            `it is a decision they are allowed to overrule.`,
        );

        // The label, not the prose. The sentence gets rewritten; the cause is
        // set at the push site and is what a report groups on. A resource
        // ceiling and a size decision are different news: one is the scan
        // running out, the other is the scan choosing.
        assert.equal(
          entry.cause,
          'sample_came_back_empty',
          `${TOO_LARGE_TARGET} was left unexamined for "${entry.cause}". It has ` +
            `to be the empty draw — a budget ceiling here would mean the scan ` +
            `ran out of room before reaching it, and this suite would be ` +
            `passing for a reason it did not intend.`,
        );
      });

      it('is NOT filed as ruled out — nothing was measured about its values', () => {
        const misfiled = outcome.ruledOut.find((s) => s.target === TOO_LARGE_TARGET);
        assert.equal(
          misfiled,
          undefined,
          `${TOO_LARGE_TARGET} is filed as checked and ruled out (${misfiled?.cause}), ` +
            `but no query was ever run against it. That is the scan claiming ` +
            `credit for restraint it did not exercise, and it also inflates ` +
            `\`candidatesVerified\` past what was really checked.`,
        );
      });
    });

    // ── damage 6 and 7: the value shapes that had never run ──────────────
    describe('value shapes redactCell had never produced from a real row', () => {
      for (const s of SHAPED) {
        it(`${s.table}.${s.column} is proposed as a candidate, pointing at ${s.parent}`, () => {
          // First, because everything below is a statement about a finding,
          // and a rule that cannot see the column produces no finding to
          // make statements about. This is also the half that pins the
          // naming convention: `damaged_asset` is read by the bare form of
          // `parentNameGuesses`, which was blind for the whole of
          // MusicBrainz and would be blind again if the branch went away.
          const seen = findCandidates(graph).find(
            (c) => c.childTable === s.table && c.childColumn === s.column,
          );

          assert.ok(
            seen,
            `${s.table}.${s.column} was never proposed as a candidate. Either ` +
              `parentNameGuesses no longer reads that name, or typesCompatible ` +
              `no longer pairs its type with ${s.parent}'s key. Everything ` +
              `below would then be vacuous.`,
          );
          assert.equal(seen.parentTable, s.parent);
          assert.equal(seen.parentSchema, FIXTURE_SCHEMA);
        });

        it(`${s.table}.${s.column}: ${s.orphans} of ${s.sampled} unmatched, redacted to ${s.shapeName}`, () => {
          const hits = outcome.findings.filter((f) => f.table === s.table);
          assert.equal(
            hits.length,
            1,
            `expected one finding on ${s.table}, got ${hits.length}. Layer B ` +
              `reported: ` +
              (outcome.findings.length === 0
                ? '(nothing at all)'
                : outcome.findings.map((f) => `${f.table}.${f.columns[0]}`).join(', ')),
          );

          const f = hits[0]!;
          assert.deepEqual(f.columns, [s.column]);
          assert.ok(f.evidence, 'a count with no query behind it is not evidence');
          assert.equal(f.evidence.rowCount, s.orphans);
          assert.equal(f.evidence.sampleSize, s.sampled);

          // The point of the whole block. These rows came out of Postgres,
          // went through the pack's redactor, and are what a history file or
          // an Evidence Pack would carry.
          assert.equal(
            f.evidence.sample.length,
            s.orphans,
            `${s.table} produced ${f.evidence.sample.length} sample rows for ` +
              `${s.orphans} orphans. With nothing to redact, the shape ` +
              `assertions below would pass over an empty list.`,
          );

          for (const row of f.evidence.sample) {
            const cell = row.orphan_value;
            assert.equal(
              typeof cell,
              'string',
              `${s.table} sampled ${JSON.stringify(cell)} — redactCell returns ` +
                `a string for every input, so a non-string here means the value ` +
                `bypassed it entirely.`,
            );
            assert.match(
              cell as string,
              s.shape,
              `${s.table}.${s.column} holds ${s.shapeName} values and this ` +
                `sample cell reduced to ${JSON.stringify(cell)}. Either the ` +
                `column stopped carrying that type, or redactCell stopped ` +
                `recognising it — and this is the branch that had never once ` +
                `run against a real row.`,
            );
          }
        });
      }

      /**
       * The null branch, locked shut rather than exercised.
       *
       * `redactCell` returns `'null'` for an empty cell and that branch is
       * unreachable today: `buildOrphanSample` selects only the candidate
       * column and requires it to be `IS NOT NULL`, so an empty cell cannot
       * be sampled at all. It is worth stating out loud because the empty
       * cell is exactly where three copies of that redactor drifted apart —
       * one returned a real `null`, one returned the string, and the store's
       * guard accepted only one of them. Nothing broke, because nothing
       * could reach the disagreement.
       *
       * Both fixture tables carry two empty cells for this test. It does not
       * make the null branch run — nothing can, while the filter is there —
       * it makes the day the filter goes away a red test rather than a
       * silent change: sampling whole rows, or dropping the NOT NULL for a
       * composite key, immediately puts `'null'` in a sample here.
       */
      it('an empty cell cannot reach a sample, and the queries say so', async () => {
        for (const s of SHAPED) {
          const counted = await client.query(
            `SELECT count(*)::int AS n FROM ${qualified(FIXTURE_SCHEMA, s.table)}`,
          );
          assert.equal(
            Number(counted.rows[0]?.n),
            s.rows,
            `${s.table} holds ${counted.rows[0]?.n} rows, not ${s.rows}. The ` +
              `fixture changed under this test, and the gap between rows and ` +
              `sampled below is what carries its meaning.`,
          );

          const f = outcome.findings.find((x) => x.table === s.table);
          assert.ok(f?.evidence, `${s.table} produced no finding to read`);

          // The gap is the two empty cells. If the NOT NULL filter went
          // away, `present` would count all 14 and this equality breaks
          // before anyone has to notice a `'null'` in a sample.
          assert.equal(
            f.evidence.sampleSize,
            s.rows - 2,
            `${s.table} has ${s.rows} rows, two of them empty, and the rule ` +
              `counted ${f.evidence.sampleSize} of them. Counting the empty ` +
              `ones means the IS NOT NULL filter is gone — and with it gone, ` +
              `redactCell's null branch is live for the first time and nothing ` +
              `has ever checked what it does downstream.`,
          );

          for (const row of f.evidence.sample) {
            assert.notEqual(
              row.orphan_value,
              'null',
              `${s.table} sampled an empty cell. That is redactCell's null ` +
                `branch running on real data for the first time. It is not ` +
                `necessarily wrong — but it has never been checked against the ` +
                `store's guard or the Evidence Pack gate, so it has to be ` +
                `looked at rather than absorbed.`,
            );
          }
        }
      });

      /**
       * The same filter, asserted on the query the finding publishes.
       *
       * The check above is behavioural and depends on the fixture holding
       * empty cells. This one reads the SQL itself, so it still fails if a
       * later fixture drops those rows. Layer B keeps `buildOrphanSample`
       * private, so what can be read from outside is `evidence.sql` — the
       * match query, which carries the same filter and is the query a user
       * is invited to re-run.
       */
      it('the published query requires every column it selects to be non-empty', () => {
        for (const s of SHAPED) {
          const f = outcome.findings.find((x) => x.table === s.table);
          assert.ok(f?.evidence, `${s.table} produced no finding to read`);

          const expected = `c.${quoteIdent(s.column)} IS NOT NULL`;
          assert.ok(
            f.evidence.sql.includes(expected),
            `the query behind ${f.id} does not contain "${expected}". Every ` +
              `column this rule selects has to be filtered to non-empty ` +
              `values, and the reason is not tidiness: dropping that filter ` +
              `revives redactCell's null branch, which no test and no real ` +
              `scan has ever exercised. Query was:\n${f.evidence.sql}`,
          );
        }
      });
    });

    /**
     * The fraction `sealFindings` refuses, asserted before anyone can build it.
     *
     * Layer B does not hand its coverage to the seal gate today — the CLI
     * assembles it — so this arithmetic breaking would not fail a build. It
     * would fail on the first person who wires `notExamined` into
     * `Coverage.skipped`, which is a reasonable thing to do and was, until
     * this split, a scan-ending one: on Pagila the old single list gave
     * 5 checked + 1 skipped out of 5 eligible.
     */
    // ── damage 10 and 11: a convention that looks like mass breakage ─────
    //
    // Debt N33. RubyGems' gem_downloads.version_id has 232,818 values that
    // match no versions row, and 232,573 of them are the single value 0 —
    // that schema's way of saying "totals across every version". The match
    // rate was 89.4%, well over MIN_MATCH_RATE, so the rule would have raised
    // a question about a quarter of a million rows of which 99.9% were a
    // design decision.
    //
    // The value gives away nothing: it is the number zero. So what is
    // measured is concentration, not shape — the same lesson as the redaction
    // gate, where the dangerous case turned out to be a person's name.
    //
    // Two fixtures, because the two halves fail in opposite directions:
    //
    //   damaged_sentinel_link    19 sentinel + 1 real  → raise the 1
    //   damaged_convention_link  20 sentinel + 0 real  → raise nothing, say so
    //
    // A fix that only handled the pure case would suppress the false positive
    // and the genuine orphan in the same move, and would look completely
    // correct from the pure case alone.
    describe('a repeated value set aside, and what survives it', () => {
      it('is proposed as a candidate at all — nothing here is blind to it', () => {
        for (const table of [SENTINEL.table, CONVENTION.table]) {
          const seen = findCandidates(graph).find((c) => c.childTable === table);
          assert.ok(
            seen,
            `${table} was never proposed as a candidate, so everything below ` +
              `it would be true for a reason this suite is not testing.`,
          );
        }
      });

      it(`${SENTINEL.table}: reports the 1 real orphan, not all ${SENTINEL.unmatched}`, () => {
        const hits = outcome.findings.filter((f) => f.table === SENTINEL.table);
        assert.equal(
          hits.length,
          1,
          `expected one finding on ${SENTINEL.table}, got ${hits.length}. ` +
            `Setting the repeated value aside must not take the genuine ` +
            `orphan hiding behind it with it.`,
        );

        const f = hits[0]!;
        assert.ok(f.evidence, `${SENTINEL.table} produced no evidence to read`);
        assert.equal(
          f.evidence.rowCount,
          SENTINEL.residual,
          `${SENTINEL.table} reports ${f.evidence.rowCount} unmatched rows. ` +
            `${SENTINEL.unmatched} means the repeated value was counted as ` +
            `${SENTINEL.sentinel} broken links — the RubyGems false positive, ` +
            `reproduced. 0 means it was set aside along with the real orphan, ` +
            `which suppresses the finding this fixture exists to keep.`,
        );
        assert.equal(f.evidence.sampleSize, SENTINEL.rows);
      });

      it(`${SENTINEL.table}: says out loud that it set rows aside`, () => {
        const f = outcome.findings.find((x) => x.table === SENTINEL.table)!;
        assert.ok(f, `${SENTINEL.table} produced no finding to read`);

        // Prose, and asserted anyway — one of the few places in this file
        // where that is right. The user is being shown 1 unmatched row out of
        // 100 while 19 more were quietly dropped from that count. A report
        // that does the arithmetic without saying so is not being cautious,
        // it is hiding a decision the reader is entitled to overrule.
        const said = `${f.plainText} ${f.technical}`;
        assert.ok(
          said.includes(String(SENTINEL.sentinel)),
          `neither sentence in ${f.id} mentions the ${SENTINEL.sentinel} rows ` +
            `that were set aside. The count the user reads went from ` +
            `${SENTINEL.unmatched} to ${SENTINEL.residual} and nothing on ` +
            `screen accounts for the difference.`,
        );
      });

      it(`${CONVENTION.table}: raises nothing, and is not silent about it`, () => {
        const raised = outcome.findings.filter((f) => f.table === CONVENTION.table);
        assert.deepEqual(
          raised.map((f) => f.id),
          [],
          `Layer B raised a question about ${CONVENTION.table}, where every ` +
            `unmatched value is the same one. That is the RubyGems false ` +
            `positive at fixture scale.`,
        );

        const entry = outcome.ruledOut.find((r) => r.target === CONVENTION_TARGET);
        assert.ok(
          entry,
          `${CONVENTION_TARGET} is neither raised nor listed as ruled out — ` +
            `it vanished. Restraint that leaves no trace cannot be told apart ` +
            `from not having looked. Ruled out: ` +
            `${outcome.ruledOut.map((r) => r.target).join(', ') || '(empty)'}.`,
        );
        assert.equal(
          entry.cause,
          'unmatched_is_one_repeated_value',
          `${CONVENTION_TARGET} was let go for "${entry.cause}". A match rate ` +
            `rejection would be a different statement — that the column is ` +
            `probably not a reference — when 80% of its values line up fine.`,
        );
      });

      it(`${LONELY.table}: one unmatched row is raised, not set aside`, () => {
        const hits = outcome.findings.filter((f) => f.table === LONELY.table);
        assert.equal(
          hits.length,
          1,
          `expected one finding on ${LONELY.table}, got ${hits.length}. A ` +
            `single unmatched row makes the dominant value 100% of the ` +
            `unmatched set, so without a floor on repetition it clears ` +
            `SENTINEL_SHARE and the column is ruled out as a convention that ` +
            `does not exist. Ruled out: ` +
            `${outcome.ruledOut.map((r) => r.target).join(', ') || '(empty)'}.`,
        );
        assert.equal(hits[0]!.evidence!.rowCount, LONELY.orphans);
      });

      it(`${LONELY.table}: is not in ruledOut under the sentinel reason`, () => {
        const misfiled = outcome.ruledOut.find((r) => r.target === LONELY_TARGET);
        assert.equal(
          misfiled,
          undefined,
          `${LONELY_TARGET} was let go for "${misfiled?.cause}". "One value, ` +
            `repeated" cannot describe a value that appears once — that is ` +
            `the rule saying something untrue about what it saw.`,
        );
      });

      it(`${CONVENTION.table}: counts as checked, not as a coverage hole`, () => {
        const misfiled = outcome.notExamined.find((s) => s.target === CONVENTION_TARGET);
        assert.equal(
          misfiled,
          undefined,
          `${CONVENTION_TARGET} is filed as never examined (${misfiled?.cause}), ` +
            `but the query ran and every value was counted. Filing a decision ` +
            `as a gap overstates what was missed and understates the work.`,
        );
      });
    });

    // ── damage 12: the fault the old sampler could not reach ─────────────
    //
    // Debt N34, and the reason it was marked ahead of everything else.
    //
    // buildMatchQuery used `LIMIT 10000` with no ORDER BY, which returns
    // whatever ten thousand rows come out of the heap first — on an
    // append-mostly table, the oldest. Measured on devops.stackexchange: 200
    // unmatched of 10,000 reported, "98.0% match" printed, against a real
    // 6,459 of 49,148. Off by 6.5x, toward the reassuring answer.
    //
    // This table is the version of that which loses the finding entirely
    // rather than shrinking it. The first 42,000 rows are spotless and every
    // unmatched value is in the last 18,000 — a fault that started recently.
    // Read the first ten thousand and there is nothing to report at all.
    describe(`${WIDE.table}.${WIDE.column}: sampled from across the whole table`, () => {
      it('is raised at all — the old sampler would have found nothing here', async () => {
        const hits = outcome.findings.filter((f) => f.table === WIDE.table);
        assert.equal(
          hits.length,
          1,
          `expected one finding on ${WIDE.table}, got ${hits.length}.`,
        );

        // The counter-measurement, run here rather than asserted from
        // memory: the exact shape the rule used to publish, against this
        // table, right now. It has to come back clean — that is what makes
        // the finding above evidence of anything.
        const old = await client.query(
          `
          WITH sampled AS (
            SELECT c.${quoteIdent(WIDE.column)} AS v
            FROM ${qualified(FIXTURE_SCHEMA, WIDE.table)} c
            WHERE c.${quoteIdent(WIDE.column)} IS NOT NULL
            LIMIT 10000
          )
          SELECT count(*) FILTER (WHERE p.id IS NULL)::int AS orphans
          FROM sampled s
          LEFT JOIN ${qualified(FIXTURE_SCHEMA, WIDE.parent)} p ON p.id = s.v
          `,
        );
        assert.equal(
          Number(old.rows[0]?.orphans),
          0,
          `the old LIMIT-with-no-ORDER-BY shape finds ` +
            `${old.rows[0]?.orphans} orphans in the first 10,000 rows of ` +
            `${WIDE.table}. It is supposed to find none — the fixture keeps ` +
            `every unmatched value in the tail. Something reordered the heap ` +
            `(CLUSTER, VACUUM FULL, a rewritten INSERT), and this table no ` +
            `longer demonstrates the bug it was built for.`,
        );
      });

      it('says it sampled, in the sentence and in the query it publishes', () => {
        const f = outcome.findings.find((x) => x.table === WIDE.table)!;
        assert.ok(f.evidence, `${WIDE.table} produced no evidence to read`);

        assert.ok(
          f.evidence.sql.includes('TABLESAMPLE'),
          `the query behind ${f.id} has no TABLESAMPLE clause, so a table of ` +
            `${WIDE.rows} rows was read by some other means. The published ` +
            `SQL is the only machine-readable statement of how the number ` +
            `was arrived at.`,
        );
        assert.ok(
          f.evidence.sql.includes('REPEATABLE'),
          `the query behind ${f.id} is not repeatable, so the user re-running ` +
            `the SQL printed under "what I measured" gets different numbers ` +
            `than the ones above it.`,
        );

        // The claim must not read as a statement about the whole table.
        assert.ok(
          /drawn from across/.test(f.plainText),
          `${f.id} describes a sampled measurement without saying it sampled. ` +
            `That is the "98.0%" sentence: a partial answer in the voice ` +
            `reserved for counted ones.`,
        );
      });

      /**
       * Debt N45, and the reason this reads as five draws rather than one.
       *
       * It used to assert that THE draw — whichever one the clock handed out
       * — landed inside a band around the table's true 30%. That is one
       * observation of a random variable, and block sampling has real spread:
       * rows inside a block are neighbours, so a draw can legitimately sit
       * well off the true share. The assertion went red once with nothing
       * broken, and a suite that mandates `0 fail` while containing a test
       * that fails by chance teaches people to re-run until green. That habit
       * is how a real red gets waved through.
       *
       * Fixed seeds here; the clock still picks the seed in production. What
       * varies between runs is the thing being measured, so pinning it in the
       * test makes the test deterministic without making the product blind —
       * a seed fixed in the SOURCE would draw the same blocks of the same
       * tables forever, which is the quieter version of the bug this
       * replaced.
       *
       * The property is unbiasedness, and one draw is a poor test of it. Five
       * spread seeds test it directly: every one lands clear of zero, and
       * their mean lands near the truth. The old `LIMIT 10000` with no
       * ORDER BY would read the clean head of this table under EVERY seed and
       * return ~0%, so the first assertion is the one that catches the
       * regression this rule exists to prevent.
       */
      const SEEDS = [1, 200_003, 400_007, 600_011, 999_983];

      it('lands near the real rate under every seed, not just a lucky one', async () => {
        const draws: { seed: number; rate: number; rows: number }[] = [];

        for (const seed of SEEDS) {
          const run = await runImplicitForeignKeys(
            client,
            graph,
            new QueryBudget(),
            'en',
            seed,
          );
          const f = run.findings.find((x) => x.table === WIDE.table);
          assert.ok(
            f?.evidence,
            `${WIDE.table} produced no evidence under seed ${seed}`,
          );
          draws.push({
            seed,
            rate: f.evidence.rowCount / f.evidence.sampleSize!,
            rows: f.evidence.sampleSize!,
          });
        }

        const shown = draws
          .map((d) => `${d.seed}: ${(d.rate * 100).toFixed(1)}% of ${d.rows}`)
          .join(', ');

        // The regression guard. The old shape read the head of the table,
        // which is 42,000 clean rows, so it came back near zero every time.
        for (const d of draws) {
          assert.ok(
            d.rate > 0.1,
            `seed ${d.seed} sampled an unmatched share of ` +
              `${(d.rate * 100).toFixed(1)}% from a table that is ` +
              `${WIDE.orphanShare} unmatched. A draw that low means the sample ` +
              `is reaching the clean head of the table again.\n  ${shown}`,
          );
        }

        // And the centre, which one draw could not have shown. Tighter than
        // the old single-draw band precisely because averaging five of them
        // is what makes it affordable.
        const mean = draws.reduce((a, d) => a + d.rate, 0) / draws.length;
        assert.ok(
          mean > 0.22 && mean < 0.38,
          `five seeds average ${(mean * 100).toFixed(1)}% unmatched against a ` +
            `true share of ${WIDE.orphanShare}. The estimator is off centre, ` +
            `which no single draw would have told you.\n  ${shown}`,
        );

        for (const d of draws) {
          assert.ok(
            d.rows > 1000,
            `only ${d.rows} rows came back under seed ${d.seed} from a table ` +
              `of ${WIDE.rows}. The percentage is derived from reltuples, so a ` +
              `sample this small means the estimate has drifted — run ANALYZE ` +
              `on ${WIDE.table}.`,
          );
        }
      });
    });

    // ── the third kind of zero ───────────────────────────────────────────
    //
    // Counting produced two: nothing is there, and nothing was seen. Block
    // sampling produced a third — nothing in what I looked at — and it is the
    // most misleading of them, because it sits inside "nothing stood out"
    // wearing the clothes of a count.
    //
    // Measured on RubyGems, which is why this exists rather than being a
    // theoretical worry: gem_downloads.version_id holds 245 genuinely
    // unmatched rows among 2,196,473, or 0.011%. A ten-thousand-row draw
    // expects one and routinely sees none. Setting that column's sentinel
    // aside was right; letting the quiet afterwards read as a clean bill
    // would not have been.
    describe('what a sample is not entitled to imply', () => {
      it('reports which columns were sampled and how small the smallest draw was', () => {
        assert.ok(
          outcome.sampling.columns >= 1,
          `no column on the fixture was sampled, so the disclosure this pins ` +
            `never gets built. ${WIDE.table} holds ${WIDE.rows} rows and is ` +
            `supposed to be over EXACT_BELOW_ROWS — run ANALYZE on it if its ` +
            `estimate has drifted.`,
        );
        assert.ok(
          outcome.sampling.smallestDraw !== null,
          'columns were sampled but no draw size came back, so a report ' +
            'cannot say how weak the weakest look was',
        );
        assert.ok(
          outcome.sampling.smallestDraw! > 0,
          'a draw of zero rows is an empty sample, which belongs in ' +
            'notExamined rather than in the count of columns that were read',
        );
      });

      it('a column with no rows to compare is counted apart from one that was', async () => {
        // Debt N39, found on MusicBrainz: 374 tables, 344 million rows, and
        // all seven of Layer B's candidates sat on derived tables the public
        // dump ships empty. The report said it had "checked 7 of them against
        // real values" three lines below a header saying 164 tables held no
        // rows. Both sentences came out of the same run.
        //
        // The expectation is computed from the fixture rather than written
        // down, so this cannot drift into agreeing with whatever the code
        // happens to produce.
        const candidates = findCandidates(graph);
        let expected = 0;
        for (const c of candidates) {
          const res = await client.query(
            `SELECT count(*)::int AS n FROM ${qualified(c.childSchema, c.childTable)} ` +
              `WHERE ${quoteIdent(c.childColumn)} IS NOT NULL`,
          );
          if (Number(res.rows[0]?.n) === 0) expected += 1;
        }

        assert.equal(
          outcome.columnsWithNoRows,
          expected,
          `the pack reports ${outcome.columnsWithNoRows} columns with nothing ` +
            `to compare and the fixture has ${expected}. That number is what ` +
            `stops "checked N against real values" from counting empty tables ` +
            `as coverage.`,
        );

        assert.ok(
          outcome.columnsWithNoRows <= outcome.candidatesVerified,
          'more columns had no rows than were checked at all, which cannot ' +
            'happen — an empty answer is still a query that ran',
        );
      });

      it('nothing counted in full is described as sampled', () => {
        // The fixture's other Layer B findings are all small tables. If this
        // number ever exceeds the number of large ones, the exact path has
        // started claiming a sample it did not take — and the disclosure
        // built from it would overstate the doubt instead of the coverage,
        // which is the same kind of lie pointing the other way.
        const sampledFindings = outcome.findings.filter(
          (f) => f.evidence !== null && f.evidence.sql.includes('TABLESAMPLE'),
        );
        assert.equal(
          sampledFindings.length,
          1,
          `${sampledFindings.length} findings carry a TABLESAMPLE query. Only ` +
            `${WIDE.table} is over the threshold on this fixture: ` +
            `${sampledFindings.map((f) => f.table).join(', ') || '(none)'}`,
        );
      });
    });

    it('checked plus never-examined never exceeds eligible', () => {
      const eligible = outcome.candidatesConsidered;
      const checked = outcome.candidatesVerified;
      const unseen = outcome.notExamined.length;

      // Guard before the inequality. 0 + 0 <= 0 holds and proves nothing:
      // a rule that had gone blind would satisfy it perfectly.
      assert.ok(
        eligible > 0,
        'Layer B proposed no candidates at all on the fixture. The ' +
          'inequality below would pass on an empty result, so it is not ' +
          'evidence of anything while this is true.',
      );
      assert.ok(
        checked > 0,
        `Layer B queried none of its ${eligible} candidates on the fixture.`,
      );
      // And the other term. Until damage 9 this was always zero, so the
      // inequality was really only `checked <= eligible` and the arithmetic
      // that actually broke — a skipped target counted twice — could not
      // have shown up here at all.
      assert.ok(
        unseen > 0,
        `Layer B examined every candidate, so the sum below has nothing in ` +
          `its skipped term and the coverage arithmetic is untested. ` +
          `${TOO_LARGE_TARGET} is in the fixture so that it does not: if it ` +
          `is being checked, its estimated size no longer exceeds the rule's ` +
          `threshold.`,
      );

      assert.ok(
        checked + unseen <= eligible,
        `coverage would read ${checked} checked and ${unseen} skipped out of ` +
          `${eligible} eligible. sealFindings() refuses that: a target the ` +
          `rule examined and then dismissed is a checked target, not a ` +
          `skipped one. Ruled out (checked): ` +
          `${outcome.ruledOut.map((s) => s.target).join(', ') || '(none)'}.`,
      );
    });

    it('claims nothing it did not measure', () => {
      for (const f of outcome.findings) {
        assert.equal(
          f.kind,
          'inference',
          `${f.id} is a ${f.kind}. Layer B does not get to state facts.`,
        );
        assert.equal(f.confidence, 'unconfirmed');
        assert.ok(f.evidence, `${f.id} has no evidence`);
        assert.ok(f.evidence.sql.length > 0, `${f.id} has no reproducible query`);
      }
    });

    /**
     * The provenance that holds the ceiling down, read off real findings.
     *
     * `claim-ceiling.test.ts` proves what the seal gate does with a
     * `name_pattern` claim. This proves the live rule declares one — the two
     * halves of the same guarantee, and the half that goes missing quietly.
     * A pack that started writing `origin: 'sampled'` would keep passing
     * every other test in this file, keep passing the gate, and would have
     * bought itself the right to say `probable` about a column it identified
     * by its name.
     *
     * The three findings are damage 4, 6 and 7. Their identity is asserted
     * above; what is asserted here is that every one of them says where it
     * came from, and says the same thing.
     */
    describe('every question carries its own provenance', () => {
      it('there are findings to read at all', () => {
        // Ahead of the loops, because a `for` over an empty list is green and
        // a rule that had gone blind would satisfy every assertion below.
        assert.equal(
          outcome.findings.length,
          6,
          `Layer B raised ${outcome.findings.length} finding(s) on the ` +
            `fixture, not the 6 the damage plants: ` +
            `${outcome.findings.map((f) => f.id).join(', ') || '(nothing at all)'}.`,
        );
      });

      it('says the guess came from a name, not from the sample it counted', () => {
        for (const f of outcome.findings) {
          assert.equal(
            f.origin,
            'name_pattern',
            `${f.id} declares origin "${f.origin}". This finding asserts two ` +
              `things — that some values do not line up, which was measured, ` +
              `and that the column is a reference at all, which was guessed ` +
              `from two names looking alike. All of the uncertainty is in the ` +
              `second, so the second is the origin. Declaring "sampled" here ` +
              `raises the ceiling to "probable" and lets Layer B speak more ` +
              `confidently than it has grounds to.`,
          );

          assert.equal(
            f.confidenceBasis,
            'name_similarity',
            `${f.id} rests its confidence on "${f.confidenceBasis}". That is ` +
              `the field CEILING is indexed by: name_similarity caps this ` +
              `claim at unconfirmed, which is what it already declares about ` +
              `itself. Any other value here is the cap coming off.`,
          );

          // Belt and braces: the two fields above are what *permits*
          // unconfirmed; this is the claim actually made. They are set in
          // different places in the pack and could drift apart.
          assert.equal(f.confidence, 'unconfirmed', f.id);
        }
      });

      it('names the child table, the column, and the parent it may point at', () => {
        for (const f of outcome.findings) {
          assert.equal(
            f.egressClass,
            'customer-system-metadata',
            `${f.id} is classified "${f.egressClass}". Sample values are ` +
              `redacted, but a reference between two named tables is still a ` +
              `piece of the customer's system map — not a product constant, ` +
              `and not harmless because nothing in it looks like PII.`,
          );
        }
      });

      it('says which release of the rule asked the question', () => {
        for (const f of outcome.findings) {
          assert.equal(
            f.engineRuleVersion,
            LAYER_B_RULE_VERSION,
            `${f.id} carries engine version "${f.engineRuleVersion}" while the ` +
              `pack exports "${LAYER_B_RULE_VERSION}". When ` +
              `parentNameGuesses learned the bare naming convention, whole ` +
              `schemas went from invisible to eligible in one release; ` +
              `without a version the store reads that as the database having ` +
              `changed overnight.`,
          );
        }
      });

      it('was measured during this run, not at some time written into the source', () => {
        for (const f of outcome.findings) {
          const at = Date.parse(f.observedAt);
          assert.ok(
            !Number.isNaN(at),
            `${f.id} was observed at "${f.observedAt}", which is not a time.`,
          );
          assert.ok(
            at >= runStartedAt && at <= runFinishedAt,
            `${f.id} says it was measured at ${f.observedAt}, outside the run ` +
              `that produced it (${new Date(runStartedAt).toISOString()} .. ` +
              `${new Date(runFinishedAt).toISOString()}).`,
          );
        }
      });

      it('records that nobody has ruled on any of them yet', () => {
        for (const f of outcome.findings) {
          assert.equal(
            f.userStatus,
            'unreviewed',
            `${f.id} is marked "${f.userStatus}". Nothing in the product asks ` +
              `the owner of the system anything yet, so nothing else can be ` +
              `true — and a pattern nobody has ruled on must not be able to ` +
              `look like one they called intentional.`,
          );
        }
      });
    });

    // ── the denominator the scope strip reads ────────────────────────────
    //
    // This pack has always counted its own candidates. What is asserted here
    // is the handover: the same three numbers in the shape `buildScopeStrip`
    // adds up, and the arithmetic that gate refuses to print without.
    describe('the rule states its own denominator', () => {
      it('publishes exactly one rule, under the id the pack owns', () => {
        assert.deepEqual(
          outcome.rules.map((r) => r.rule),
          [IMPLICIT_FK_RULE],
          'the coverage names a rule the pack does not publish findings ' +
            'under, or names none at all — either way the strip would be ' +
            'totalling targets nobody can trace back to a rule.',
        );
      });

      it(`${IMPLICIT_FK_RULE}: checked + notChecked === eligible`, () => {
        const c = outcome.rules[0];
        assert.ok(c);

        // The empty-set guard. `0 + 0 === 0` is true of a rule that has gone
        // blind, and Pagila has candidates in it by construction — the trap
        // column and the too-large column are both in this denominator.
        assert.ok(
          c.eligible !== null && c.eligible > 0,
          `the rule reports ${c.eligible} eligible candidates on a fixture ` +
            `built to contain them. The equality below would hold on an ` +
            `empty set and prove nothing.`,
        );

        assert.equal(
          c.checked + c.notChecked,
          c.eligible,
          `${c.checked} checked and ${c.notChecked} not checked out of ` +
            `${c.eligible}. Every candidate takes exactly one of the two ` +
            `paths, and a candidate queried and then let go is CHECKED.`,
        );
      });

      /**
       * The coverage is the pack's own numbers, not a second count of them.
       *
       * Two ways of saying one thing is two things that can disagree, and the
       * report prints only one of them. This pins them together.
       */
      it('agrees with the counts the pack already reported', () => {
        const c = outcome.rules[0];
        assert.ok(c);
        assert.deepEqual(
          {
            eligible: c.eligible,
            checked: c.checked,
            notChecked: c.notChecked,
          },
          {
            eligible: outcome.candidatesConsidered,
            checked: outcome.candidatesVerified,
            notChecked: outcome.notExamined.length,
          },
        );
      });

      /**
       * The candidate that was checked and let go is on the checked side.
       *
       * This is the defect Layer B was repaired for last round, restated
       * against the new field: `ruledOut` entries are inside `checked`, and
       * counting them as a coverage hole would overstate what was missed and
       * understate what was done, in one move.
       */
      it('counts what it ruled out as checked, not as a hole', () => {
        const c = outcome.rules[0];
        assert.ok(c);
        assert.ok(
          outcome.ruledOut.length > 0,
          `nothing was ruled out on a fixture that plants ${TRAP.table}.` +
            `${TRAP.column} to be ruled out. The assertion below would pass ` +
            `on an empty list.`,
        );
        assert.ok(
          c.checked >= outcome.ruledOut.length,
          `${c.checked} checked is fewer than the ${outcome.ruledOut.length} ` +
            `candidates the rule says it queried and let go. Restraint is ` +
            `work, and it has to be inside the work that was done.`,
        );
      });
    });
  });
}

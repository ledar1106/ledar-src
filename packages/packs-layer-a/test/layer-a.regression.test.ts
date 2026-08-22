/**
 * Layer A regression against the Pagila fixture.
 *
 * Four of the deliberate faults in `fixture-damage.sql` belong to Layer A.
 * Until this suite existed they were confirmed by a person reading the stdout
 * of `npm run scan` and counting. That check works exactly as long as
 * somebody remembers to look, which is another way of saying it stops
 * working.
 *
 * Everything asserted here is structure: rule id, kind, confidence,
 * severity, table, column, count. The prose in `plainText` is deliberately
 * left alone — it will be reworded, and a suite that fails on rewording is a
 * suite people learn to ignore. A check that cries wolf is a check that gets
 * skipped.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { QueryBudget, readSchemaGraph } from '@ledar/connector-postgres';
import { buildScopeStrip } from '@ledar/contracts';
import {
  CHECK_VIOLATED_RULE,
  FK_ORPHANS_RULE,
  INDEX_NOT_ENFORCING_RULE,
  LAYER_A_RULE_VERSION,
  runLayerA,
} from '@ledar/packs-layer-a';

import { FIXTURE_SCHEMA, announceSkip, openPagila } from '@ledar/test-fixtures';

const SUITE = 'Layer A regression against the Pagila fixture';

/**
 * Taken from what the functions return, rather than imported by name.
 *
 * The shape of a finding is being reworked in `@ledar/contracts` while this
 * is being written. What this suite is pinning down is the *content* of the
 * result — counts, severities, which table — not what the type is called
 * this week, and a test that breaks on a rename is noise.
 */
type Graph = Awaited<ReturnType<typeof readSchemaGraph>>;
type LayerAOutcome = Awaited<ReturnType<typeof runLayerA>>;
type LayerAFinding = LayerAOutcome['findings'][number];
type LayerARuleCoverage = LayerAOutcome['rules'][number];

/**
 * Finds the one finding a check is about, and says what it saw when there
 * is none.
 *
 * `findings.find(...)!` would report `undefined has no property severity`,
 * which tells the next person nothing about which rule went quiet.
 */
function pick(findings: LayerAFinding[], rule: string, table: string): LayerAFinding {
  const hit = findings.filter((f) => f.rule === rule && f.table === table);
  assert.equal(
    hit.length,
    1,
    `expected exactly one finding for rule "${rule}" on "${table}", got ` +
      `${hit.length}. What Layer A did report: ` +
      (findings.length === 0
        ? '(nothing at all)'
        : findings.map((f) => `${f.rule}@${f.table}`).join(', ')),
  );
  return hit[0]!;
}

const gate = await openPagila();

if (!gate.ok) {
  announceSkip(SUITE, gate.reason);

  // Registered as a skipped test rather than a skipped suite, so it lands in
  // the runner's "skipped" tally. A suite that disappears from the totals
  // reads as "nothing to do here"; a skipped test reads as a hole.
  describe(SUITE, () => {
    it('the three Layer A faults were not measured', { skip: gate.reason }, () => {
      assert.fail('unreachable: this test is skipped');
    });
  });
} else {
  const client = gate.client;

  let graph: Graph;
  let outcome: LayerAOutcome;
  let findings: LayerAFinding[];

  /**
   * The same rules, over the same graph, with the damage filtered out.
   *
   * Layer A only says "nothing found" when it found nothing, so its two
   * negative claims are unreachable on a fixture built to be broken — and
   * they are two of the six places provenance has to be declared. Removing
   * the unvalidated constraints and the switched-off indexes from the graph
   * reaches that branch without a second database, and without a hand-built
   * graph that could drift from what `readSchemaGraph` really produces. No
   * query is issued on this path at all, which is itself part of why those
   * two claims say `catalog`.
   */
  let cleanFindings: LayerAFinding[];

  /**
   * The window every `observedAt` has to land inside.
   *
   * Bare "is it a parseable date" is satisfied by any constant somebody types
   * into the source, which is the one failure this field exists to prevent:
   * a stamp that is not a measurement. Bracketing the run turns it into a
   * statement about when the claim was actually made.
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

      const undamaged: Graph = {
        ...graph,
        constraints: graph.constraints.filter((c) => c.validated),
        indexes: graph.indexes.filter((i) => i.isValid && i.isReady),
      };

      // A fresh, full budget. The CLI hands each layer half of one, which is
      // right for a live scan and wrong here: a missing finding must mean
      // the rule stopped seeing it, never that the scan ran out of room.
      runStartedAt = Date.now();
      outcome = await runLayerA(client, graph, new QueryBudget());
      findings = outcome.findings;
      cleanFindings = (await runLayerA(client, undamaged, new QueryBudget())).findings;
      runFinishedAt = Date.now();
    });

    after(async () => {
      await client.end();
    });

    it('states facts rather than a "nothing found" claim', () => {
      assert.equal(
        findings.filter((f) => f.kind === 'negative').length,
        0,
        'Layer A emitted a negative claim while the fixture damage is present',
      );
    });

    // ── fault 1 ──────────────────────────────────────────────────────────
    // FK declared NOT VALID, three rows already orphaned when it was added.
    it('damaged_rental_note: 3 orphans behind a NOT VALID foreign key', () => {
      const f = pick(
        findings,
        'layer-a/unvalidated-foreign-key-has-orphans',
        'damaged_rental_note',
      );

      assert.equal(f.kind, 'observation');
      assert.equal(f.confidence, 'certain');
      assert.equal(f.severity, 'high');
      assert.equal(f.schema, FIXTURE_SCHEMA);
      assert.deepEqual(f.columns, ['rental_id']);

      assert.ok(f.evidence, 'an observation with no evidence is an inference');
      assert.equal(f.evidence.rowCount, 3);
      // Not truncated: three is nowhere near the counting ceiling, so a
      // truncation marker here would mean the counter lost its place.
      assert.equal(f.coverage.truncatedAt, null);
    });

    // ── fault 2 ──────────────────────────────────────────────────────────
    // CHECK declared NOT VALID over seven rows, four of them negative.
    it('damaged_payment_audit: 4 rows violating a NOT VALID check', () => {
      const f = pick(
        findings,
        'layer-a/unvalidated-check-is-violated',
        'damaged_payment_audit',
      );

      assert.equal(f.kind, 'observation');
      assert.equal(f.confidence, 'certain');
      assert.equal(f.severity, 'high');
      assert.equal(f.schema, FIXTURE_SCHEMA);
      assert.deepEqual(f.columns, ['amount_cents']);

      assert.ok(f.evidence, 'an observation with no evidence is an inference');
      assert.equal(f.evidence.rowCount, 4);
      assert.equal(f.coverage.truncatedAt, null);
    });

    // ── fault 3 ──────────────────────────────────────────────────────────
    // A unique index switched off in the catalog. It still exists, still has
    // a name, and enforces nothing — the failure mode a person reading
    // `\d damaged_slug` would walk straight past.
    it('damaged_slug: the unique index is switched off, severity high', () => {
      const f = pick(findings, 'layer-a/index-not-enforcing', 'damaged_slug');

      assert.equal(f.kind, 'observation');
      assert.equal(f.confidence, 'certain');
      // High specifically because it is unique. A non-unique index left
      // half-built is a speed problem; this one is a correctness one, and
      // dropping it to medium would bury it.
      assert.equal(f.severity, 'high');
      assert.equal(
        f.id,
        `layer-a/invalid-index/${FIXTURE_SCHEMA}.damaged_slug.damaged_slug_unique`,
      );

      const idx = graph.indexes.find((i) => i.name === 'damaged_slug_unique');
      assert.ok(idx, 'damaged_slug_unique is not in the schema graph');
      assert.equal(idx.isUnique, true);
      assert.equal(idx.isValid, false);
    });

    /**
     * Debt N27: this claim used to publish evidence for a query nobody ran.
     *
     * `durationMs: 0` and `rowCount: 1` were written in by hand, and the SQL
     * string was assembled and then dropped on the floor. The finding said
     * "here is the query behind this number" about a statement that was never
     * sent — a declared measurement that did not happen, inside the one rule
     * allowed to speak with `certain`.
     *
     * `check:sql` passed it the whole time, and passed it honestly: that
     * check proves every fragment reaching a statement came from a sanitiser,
     * and this fragment never reached one. A checker cannot see a query that
     * is never sent, which is why the assertion below is the one that had to
     * exist — it takes the published SQL and RUNS it.
     *
     * That also covers the quoting. The old string interpolated the index
     * name raw, so an index legally named   o'brien   would not have parsed —
     * a fact nobody could discover while the string was never executed.
     */
    it('the query it publishes as evidence is one that really runs', async () => {
      const f = pick(findings, 'layer-a/index-not-enforcing', 'damaged_slug');
      assert.ok(f.evidence, 'an observation with no evidence is not a claim');

      assert.ok(
        f.evidence.durationMs > 0,
        `the evidence reports ${f.evidence.durationMs}ms. A query that took ` +
          `no measurable time is a query that was not sent, which is the ` +
          `whole of N27.`,
      );

      // The published SQL, run verbatim against the same database. If it does
      // not parse, does not return a row, or returns a row that disagrees
      // with the finding, then the sentence under "what I measured" is not
      // describing this claim.
      const res = await client.query(f.evidence.sql);
      assert.equal(
        res.rows.length,
        f.evidence.rowCount,
        `the published query returns ${res.rows.length} rows and the evidence ` +
          `claims ${f.evidence.rowCount}. A user re-running the query printed ` +
          `in the report would not see what the report says they would.`,
      );
      assert.equal(
        res.rows[0]?.indisvalid,
        false,
        'the published query says this index is valid, while the finding ' +
          'above says it is switched off. One of the two is wrong and the ' +
          'user has no way to tell which.',
      );
    });

    // ── fault 8 ──────────────────────────────────────────────────────────
    // A NOT VALID foreign key over two columns at once, one text and one
    // uuid. Both halves of that are the point (debt N20):
    //
    //   two columns   `redactRow` is a loop over the cells of a row, and
    //                 every other sample in this fixture is one column wide,
    //                 so on real data that loop had never gone round twice.
    //   not integers  every orphan column Layer A had until now held
    //                 integers, so the row-wise redactor had only ever
    //                 produced `<number>` outside a hand-written unit test.
    //
    // What each cell reduces to is asserted where it can be checked against
    // the column's own Postgres type, in
    // packages/store/test/redaction-chain.pagila.test.ts. What is asserted
    // here is the structure that makes that possible: the count, both key
    // columns, and a sample row that really does carry two cells.
    it('damaged_label_link: 3 orphans behind a composite NOT VALID foreign key', () => {
      const f = pick(
        findings,
        'layer-a/unvalidated-foreign-key-has-orphans',
        'damaged_label_link',
      );

      assert.equal(f.kind, 'observation');
      assert.equal(f.confidence, 'certain');
      assert.equal(f.severity, 'high');
      assert.equal(f.schema, FIXTURE_SCHEMA);
      assert.deepEqual(f.columns, ['label_slug', 'label_key']);

      assert.ok(f.evidence, 'an observation with no evidence is an inference');
      assert.equal(f.evidence.rowCount, 3);
      assert.equal(f.coverage.truncatedAt, null);

      assert.equal(
        f.evidence.sample.length,
        3,
        `the finding counted ${f.evidence.rowCount} orphans and kept ` +
          `${f.evidence.sample.length} sample rows. With no sample rows there ` +
          `is nothing for redactRow to have run over, and the assertion below ` +
          `would pass over an empty list.`,
      );

      for (const row of f.evidence.sample) {
        assert.deepEqual(
          Object.keys(row).sort(),
          ['label_key', 'label_slug'],
          `a sampled row carries ${JSON.stringify(Object.keys(row))}. Both key ` +
            `columns have to be in it: one cell per row is the width every ` +
            `other sample in this fixture has, and it is the width at which ` +
            `redactRow and redactCell are indistinguishable.`,
        );
      }
    });

    // ── provenance: where each claim says it came from ───────────────────
    //
    // `_doc/05` section 7 puts these on the claim rather than on the run,
    // because a claim travels alone — into a report, into a model's prompt,
    // into a proxy — and everything the run knew about how it was measured
    // stays behind unless the claim carries it.
    //
    // What is asserted here is that the values are the ones the measurement
    // supports, not merely that the fields are populated. `origin: 'counted'`
    // on a rule that read a catalog flag would satisfy the schema, satisfy
    // the seal gate, and be a lie — and the ceiling that stops Layer B
    // overstating itself is built out of exactly these two fields, so a rule
    // that misdeclares them is a rule that has quietly bought itself a
    // certainty it did not earn.
    describe('every claim carries its own provenance', () => {
      type Provenance = {
        origin: LayerAFinding['origin'];
        confidenceBasis: LayerAFinding['confidenceBasis'];
      };

      /** Counted rows are counted; catalog flags are read. One or the other. */
      const EXPECTED = new Map<string, Provenance>([
        [
          'layer-a/unvalidated-foreign-key-has-orphans',
          { origin: 'counted', confidenceBasis: 'full_count' },
        ],
        [
          'layer-a/unvalidated-check-is-violated',
          { origin: 'counted', confidenceBasis: 'full_count' },
        ],
        [
          'layer-a/index-not-enforcing',
          { origin: 'catalog', confidenceBasis: 'database_constraint' },
        ],
        [
          'layer-a/no-declared-constraint-violations',
          { origin: 'counted', confidenceBasis: 'full_count' },
        ],
        [
          'layer-a/no-index-left-invalid',
          { origin: 'catalog', confidenceBasis: 'database_constraint' },
        ],
      ]);

      function check(f: LayerAFinding): void {
        const want = EXPECTED.get(f.rule);
        assert.ok(
          want,
          `${f.id} was published under rule "${f.rule}", which nothing in this ` +
            `table describes. A new rule needs its provenance decided here ` +
            `before it can be trusted in a report: known rules are ` +
            `${[...EXPECTED.keys()].join(', ')}.`,
        );

        assert.equal(
          f.origin,
          want.origin,
          `${f.id} says it came from "${f.origin}". ${f.rule} reaches its ` +
            `answer by ${want.origin === 'counted' ? 'counting rows' : 'reading a catalog flag'}, ` +
            `so "${want.origin}" is where it came from — and origin is half of ` +
            `what decides how confidently this claim is allowed to speak.`,
        );

        assert.equal(
          f.confidenceBasis,
          want.confidenceBasis,
          `${f.id} rests its confidence on "${f.confidenceBasis}" while ` +
            `declaring origin "${f.origin}". sealFindings pairs those two, so ` +
            `either this finding is not published at all or one of the two ` +
            `fields is describing a different measurement than the one that ` +
            `ran.`,
        );

        // Table and column names are not PII and they are not a product
        // constant either. They are a map of somebody's system.
        assert.equal(f.egressClass, 'customer-system-metadata', f.id);

        assert.equal(
          f.engineRuleVersion,
          LAYER_A_RULE_VERSION,
          `${f.id} carries engine version "${f.engineRuleVersion}" while the ` +
            `pack exports "${LAYER_A_RULE_VERSION}". A literal written at the ` +
            `finding site drifts from the constant on the first bump, and the ` +
            `store then reads two rule versions where one release shipped.`,
        );

        // Nobody has been asked yet, and the field says so rather than
        // leaving a reader to assume agreement.
        assert.equal(f.userStatus, 'unreviewed', f.id);

        const at = Date.parse(f.observedAt);
        assert.ok(
          !Number.isNaN(at),
          `${f.id} was observed at "${f.observedAt}", which is not a time.`,
        );
        assert.ok(
          at >= runStartedAt && at <= runFinishedAt,
          `${f.id} says it was measured at ${f.observedAt}, outside the run ` +
            `that produced it (${new Date(runStartedAt).toISOString()} .. ` +
            `${new Date(runFinishedAt).toISOString()}). A stamp that does not ` +
            `move with the run is a constant, not a measurement.`,
        );
      }

      it('the damage rules all produced something to read', () => {
        // Before the loops. Every assertion below is inside a `for`, and a
        // `for` over an empty list is green — the shape this repo has already
        // been caught by more than once.
        const seen = new Set(findings.map((f) => f.rule));
        for (const rule of [
          'layer-a/unvalidated-foreign-key-has-orphans',
          'layer-a/unvalidated-check-is-violated',
          'layer-a/index-not-enforcing',
        ]) {
          assert.ok(
            seen.has(rule),
            `${rule} produced no finding on the damaged fixture, so the ` +
              `provenance checks below never look at it. Layer A reported: ` +
              `${[...seen].join(', ') || '(nothing at all)'}.`,
          );
        }
      });

      it('the positive claims declare what they measured with', () => {
        assert.ok(findings.length > 0, 'no findings to check');
        for (const f of findings) check(f);
      });

      it('the two "nothing found" claims declare it as well', () => {
        // The negative branch is only reachable with the damage filtered out,
        // so this half of the run is checked for having happened at all
        // before anything is asserted about its contents.
        assert.deepEqual(
          cleanFindings.map((f) => f.rule).sort(),
          [
            'layer-a/no-declared-constraint-violations',
            'layer-a/no-index-left-invalid',
          ],
          `an undamaged graph produced ${cleanFindings.length} finding(s): ` +
            `${cleanFindings.map((f) => f.id).join(', ') || '(none)'}. Both ` +
            `negative claims have to be there, or the provenance of the two ` +
            `sites that build them is untested.`,
        );

        for (const f of cleanFindings) {
          assert.equal(f.kind, 'negative', f.id);
        }

        // The constraint claim is the one rule whose provenance is not a
        // constant, so the table above cannot describe it and `check()` is
        // not asked to. An undamaged graph has no unvalidated constraints at
        // all, so no count runs and the answer comes off the catalog. With
        // constraints present it is a full count, which the positive claims
        // above already cover.
        //
        // Both bases carry a ceiling of `certain`, so getting this wrong
        // changes nothing downstream and nothing would have complained. That
        // is exactly why it is asserted: a claim that says it counted rows
        // when no query ran is the habit AGENTS.md §4.1b is about.
        const constraints = cleanFindings.find(
          (f) => f.rule === 'layer-a/no-declared-constraint-violations',
        );
        assert.ok(constraints);
        assert.equal(
          constraints.origin,
          'catalog',
          'with nothing eligible to check, this claim is read off the ' +
            'catalog. Declaring `counted` would describe a count that never ran.',
        );
        assert.equal(constraints.confidenceBasis, 'database_constraint');

        const indexes = cleanFindings.find(
          (f) => f.rule === 'layer-a/no-index-left-invalid',
        );
        assert.ok(indexes);
        check(indexes);
      });
    });

    it('every Layer A finding carries a query that reproduces it', () => {
      for (const f of findings) {
        assert.ok(f.evidence, `${f.id} has no evidence`);
        assert.ok(f.evidence.sql.length > 0, `${f.id} has no reproducible query`);
        assert.equal(typeof f.coverage.checked, 'number');
        assert.equal(typeof f.coverage.eligible, 'number');
      }
    });

    // ── coverage per rule ────────────────────────────────────────────────
    //
    // The other half of VS-4, and the half that is not visible in any
    // finding. `Coverage` on a finding describes that finding — the index
    // rule writes `1 of 1` on every invalid index it raises — so adding those
    // up counts findings and calls the answer coverage. These assertions are
    // about the denominators the rules started from, in three units that do
    // not mix: unvalidated foreign keys, unvalidated CHECK constraints, and
    // indexes this account can see.
    describe('each rule states its own denominator', () => {
      function coverageFor(rule: string): LayerARuleCoverage {
        const hit = outcome.rules.filter((r) => r.rule === rule);
        assert.equal(
          hit.length,
          1,
          `expected exactly one coverage entry for "${rule}", got ${hit.length}. ` +
            `Layer A reported: ${outcome.rules.map((r) => r.rule).join(', ') || '(nothing)'}`,
        );
        return hit[0]!;
      }

      it('reports all three rules, whether or not they raised anything', () => {
        assert.deepEqual(
          outcome.rules.map((r) => r.rule).sort(),
          [CHECK_VIOLATED_RULE, FK_ORPHANS_RULE, INDEX_NOT_ENFORCING_RULE].sort(),
          'a rule missing from this list is a rule whose targets are in ' +
            'none of the strip’s numbers, and nothing on the line would say so.',
        );
      });

      for (const rule of [
        FK_ORPHANS_RULE,
        CHECK_VIOLATED_RULE,
        INDEX_NOT_ENFORCING_RULE,
      ]) {
        it(`${rule}: checked + notChecked === eligible, over a real denominator`, () => {
          const c = coverageFor(rule);

          // The empty-set guard, first, and it is not a formality. Every
          // equality below is satisfied by `0 + 0 === 0`, which is true of a
          // rule that has gone blind and of a rule with nothing to look at,
          // and reads identically. The fixture has unvalidated foreign keys,
          // unvalidated CHECK constraints and indexes in it, so a zero here
          // means the rule stopped seeing its own targets.
          assert.ok(
            c.eligible !== null && c.eligible > 0,
            `${rule} reports ${c.eligible} eligible targets on a fixture ` +
              `built to contain them. Everything asserted after this line ` +
              `would pass on an empty set and prove nothing.`,
          );

          assert.equal(
            c.checked + c.notChecked,
            c.eligible,
            `${rule} reports ${c.checked} checked and ${c.notChecked} not ` +
              `checked out of ${c.eligible}. Every target takes exactly one ` +
              `of the two paths; a target examined and then let go is ` +
              `CHECKED, and one nobody reached is not.`,
          );
        });
      }

      /**
       * The distinction the whole change exists for.
       *
       * Pagila has one switched-off index planted in it and a great many
       * healthy ones. If `checked` were the number of findings — or anything
       * derived from them — it would read 1. Restraint is work, and the
       * healthy indexes are where nearly all of this rule's work went.
       */
      it('counts indexes it examined and let go, not indexes it raised', () => {
        const c = coverageFor(INDEX_NOT_ENFORCING_RULE);
        const raised = findings.filter(
          (f) => f.rule === INDEX_NOT_ENFORCING_RULE,
        ).length;

        assert.ok(raised > 0, 'the planted invalid index is not being reported');
        assert.ok(
          c.checked > raised,
          `the index rule says it checked ${c.checked} and raised ${raised}. ` +
            `Equal numbers mean this is counting findings under the name of ` +
            `coverage — which on a database with one bad index among two ` +
            `hundred good ones reads "1 of 1".`,
        );
        assert.equal(c.checked, c.eligible, 'no index can be missed by this rule');
      });

      /**
       * The gate, on real numbers, rather than the arithmetic above repeated.
       *
       * `buildScopeStrip` is what the report calls, and it refuses a rule
       * whose parts do not reach its whole. Running it here means the
       * assertions above are checked by the same code the scan runs, not by
       * a second opinion written next to them.
       */
      it('the real coverage is one buildScopeStrip will accept', () => {
        const strip = buildScopeStrip(
          {
            database: 'pagila',
            role: 'ledar_reader',
            schemas: [FIXTURE_SCHEMA],
            visibleTables: graph.tables.length,
            totalTables: graph.tables.length,
            grantedAt: null,
            readOnlyEnforcedByDatabase: true,
            disclosure: null,
          },
          outcome.rules,
        );

        assert.notEqual(
          strip.targetsEligible,
          null,
          'a Layer A rule could not state its own denominator, so the strip ' +
            'has no total to print at all',
        );
        assert.ok(
          strip.targetsEligible !== null && strip.targetsEligible > 0,
          'the strip totalled zero eligible targets on a fixture full of them',
        );
        assert.equal(
          strip.targetsChecked + strip.targetsNotChecked,
          strip.targetsEligible,
        );
        assert.deepEqual(strip.rulesWithoutDenominator, []);
        assert.deepEqual(strip.rulesThatDidNotRun, []);
      });
    });
  });
}

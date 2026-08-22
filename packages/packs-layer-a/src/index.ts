/**
 * Layer A — constraints the database was told to enforce, that it is not.
 *
 * Everything in here is verifiable without asking a human. A constraint says
 * what should be true; a counter-query counts the rows where it is not. If
 * the count is above zero, the finding is a fact, not an opinion — which is
 * why Layer A can be measured on a database whose owner cannot read SQL.
 *
 * Layer B — patterns that merely look wrong — lives elsewhere and is held to
 * a different standard, because a pattern is not a defect until the person
 * who owns the system says it was not intended.
 */

import type { Client } from 'pg';
import { qualified, quoteIdent, quoteLiteral } from '@ledar/connector-postgres';
import type {
  Constraint,
  IndexInfo,
  QueryBudget,
  SchemaGraph,
} from '@ledar/connector-postgres';
import {
  redactRow,
  sealFindings,
  type Coverage,
  type EgressClass,
  type Evidence,
  type FindingDraft,
  type RuleCoverage,
  type SealedFinding,
} from '@ledar/contracts';

const SAMPLE_LIMIT = 5;
const COUNT_LIMIT = 10_000;

/**
 * Which release of Layer A's detection rules produced a claim.
 *
 * Every finding this pack publishes carries it. **Bump it whenever a
 * detection rule changes what it would decide** — a different query, a
 * different ceiling, a different set of eligible targets, a different bar for
 * calling something a violation. Rewording a sentence is not a bump, and
 * neither is a refactor that cannot change a verdict.
 *
 * Without it the history store can tell a changed count from a changed
 * verdict, and no more. It cannot tell either of those from *the rule having
 * been rewritten between two releases* — and after such a rewrite every
 * finding reads as changed, or none does, depending only on which fields the
 * rewrite happened to touch. Neither reading is the truth, and nothing
 * downstream has a way to ask.
 */
export const LAYER_A_RULE_VERSION = 'layer-a@1.0.0';

/**
 * The three rule ids this pack detects under, named once.
 *
 * Exported, and read from here by both the findings below and the coverage
 * returned beside them, because those two have to be talking about the same
 * rule. Written out twice, a rename produces a rule that has a denominator
 * and no findings, or findings and no denominator — and a report printing
 * both would look consistent while describing two different things. Layer B
 * exports `IMPLICIT_FK_RULE` for exactly this reason, after a copied string
 * in the CLI nearly grew a second rule in the history that never ran.
 *
 * The two negative claims further down publish under ids of their own
 * (`layer-a/no-declared-constraint-violations`,
 * `layer-a/no-index-left-invalid`) and are deliberately not listed here: a
 * negative claim is what one of these three rules found, not a fourth rule
 * with its own targets, and giving it a row in the coverage would count the
 * same constraints twice.
 */
export const FK_ORPHANS_RULE = 'layer-a/unvalidated-foreign-key-has-orphans';
export const CHECK_VIOLATED_RULE = 'layer-a/unvalidated-check-is-violated';
export const INDEX_NOT_ENFORCING_RULE = 'layer-a/index-not-enforcing';

/**
 * How far a Layer A claim is allowed to travel.
 *
 * Every sentence this pack writes names a schema, a table, a column, a
 * constraint, or a count. No raw row value reaches a finding — samples go
 * through `redactRow` first. That does not make a finding anonymous: a list
 * of table and column names is a map of the customer's system, so it is
 * declared as their data of a stated class rather than left to be inferred
 * from the absence of anything that looks like PII. Names of people have no
 * shape to detect, and neither do names of tables.
 */
const EGRESS: EgressClass = 'customer-system-metadata';

/**
 * Why a target was not examined.
 *
 * Two causes, and they do not mean the same thing to a reader. A ceiling is
 * a resource limit: the constraint is fine as far as anyone knows, there was
 * simply no room left. A failed query is a table nobody could look inside —
 * permission denied, a lock, a timeout — and a table that cannot be read is
 * the one worth asking about.
 *
 * The label is set where the skip happens. It is not recovered afterwards by
 * matching the reason text: prose changes, and a check that reads prose to
 * decide what happened breaks without saying so.
 */
type SkipCause = 'budget_ceiling' | 'query_failed';

type SkippedTarget = Coverage['skipped'][number] & { cause: SkipCause };

/** Drops the internal label; `Coverage` carries target and reason only. */
function asCoverageSkips(skips: readonly SkippedTarget[]): Coverage['skipped'] {
  return skips.map(({ target, reason }) => ({ target, reason }));
}

/**
 * What "nothing found" is allowed to mean, given how much was looked at.
 *
 * Having checked none of them is not an all-clear, and saying so is not a
 * detail: "nothing found" and "nothing looked at" produce the same empty
 * list, and only the sentence tells them apart.
 */
function constraintPlainText(eligible: number, checked: number): string {
  if (eligible === 0) {
    return (
      `Nothing here was left half-enforced: this database has no constraints ` +
      `that Postgres was told to keep but never checked, so there was nothing ` +
      `for this rule to look at.`
    );
  }

  if (checked === 0) {
    return (
      `I could not check any of the ${eligible} ` +
      `constraint${eligible === 1 ? '' : 's'} in scope, so I have nothing to ` +
      `report about them. That is not the same as nothing being wrong.`
    );
  }

  if (checked === 1) {
    return (
      `The one constraint I was able to check is being kept — no row in it ` +
      `breaks the rule it was given.`
    );
  }

  return (
    `Every one of the ${checked} constraints I was able to check is being ` +
    `kept — no row in any of them breaks the rule it was given.`
  );
}

/** The same, for the index rule and its own denominator. */
function indexPlainText(eligible: number, where: string): string {
  if (eligible === 0) {
    return (
      `This account cannot see any indexes in ${where}, so there was nothing ` +
      `for this rule to look at.`
    );
  }

  if (eligible === 1) {
    return (
      `The one index I can see is switched on. If it was built to stop ` +
      `duplicates, it is stopping them.`
    );
  }

  return (
    `All ${eligible} indexes I can see are switched on. Nothing that was ` +
    `built to stop duplicates is sitting there not stopping them.`
  );
}

/**
 * Counts rows on the child side pointing at a parent row that is not there.
 *
 * Only built for foreign keys Postgres has not validated. A validated
 * foreign key cannot have orphans, so running this against one would burn
 * the user's database for a guaranteed zero.
 */
export function buildOrphanQuery(fk: Constraint): string {
  const child = qualified(fk.schema, fk.table);
  const parent = qualified(fk.referencedSchema!, fk.referencedTable!);

  const joinOn = fk.columns
    .map((col, i) => {
      const refCol = fk.referencedColumns[i];
      if (!refCol) throw new Error(`Foreign key ${fk.name} has mismatched columns.`);
      return `c.${quoteIdent(col)} = p.${quoteIdent(refCol)}`;
    })
    .join(' AND ');

  // A NULL on the child side is not an orphan — an unset reference is
  // allowed by the constraint itself.
  const notNull = fk.columns.map((col) => `c.${quoteIdent(col)} IS NOT NULL`).join(' AND ');

  return `
    SELECT count(*)::int AS orphans
    FROM (
      SELECT 1
      FROM ${child} c
      LEFT JOIN ${parent} p ON ${joinOn}
      WHERE ${notNull} AND p.${quoteIdent(fk.referencedColumns[0]!)} IS NULL
      LIMIT ${COUNT_LIMIT}
    ) s
  `;
}

export function buildOrphanSampleQuery(fk: Constraint): string {
  const child = qualified(fk.schema, fk.table);
  const parent = qualified(fk.referencedSchema!, fk.referencedTable!);
  const joinOn = fk.columns
    .map((col, i) => `c.${quoteIdent(col)} = p.${quoteIdent(fk.referencedColumns[i]!)}`)
    .join(' AND ');
  const notNull = fk.columns.map((col) => `c.${quoteIdent(col)} IS NOT NULL`).join(' AND ');
  const selected = fk.columns.map((col) => `c.${quoteIdent(col)}`).join(', ');

  return `
    SELECT ${selected}
    FROM ${child} c
    LEFT JOIN ${parent} p ON ${joinOn}
    WHERE ${notNull} AND p.${quoteIdent(fk.referencedColumns[0]!)} IS NULL
    LIMIT ${SAMPLE_LIMIT}
  `;
}

/** Counts rows failing a CHECK the database never verified. */
export function buildCheckViolationQuery(c: Constraint): string {
  const target = qualified(c.schema, c.table);
  // pg_get_constraintdef returns "CHECK ((expr)) NOT VALID" — the expression
  // is lifted out and negated, so the query counts what the check forbids.
  if (!c.checkExpression) {
    throw new Error(`No decompiled expression for ${c.name}; refusing to guess.`);
  }
  return `
    SELECT count(*)::int AS violations
    FROM (
      SELECT 1 FROM ${target} WHERE NOT (${c.checkExpression}) LIMIT ${COUNT_LIMIT}
    ) s
  `;
}

/**
 * Runs a query and records both how long it took and *when it was true*.
 *
 * `observedAt` is stamped here rather than where the finding is assembled,
 * for the same reason `SkipCause` is set at the skip site: a fact recorded
 * where it happens cannot drift, and one recovered afterwards can. Assembling
 * a finding is not a measurement, and a scan across a few hundred tables runs
 * long enough for somebody to write to the database in between.
 *
 * The stamp is taken before the statement is sent, not after the answer
 * arrives. Postgres takes a statement's snapshot as it begins, so the count
 * that comes back is true of the database at that moment; dating it by the
 * moment it returned would put a slow query's answer minutes after the
 * database state it describes.
 */
async function timedQuery(
  client: Client,
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; durationMs: number; observedAt: string }> {
  const observedAt = new Date().toISOString();
  const t0 = performance.now();
  const res = await client.query(sql);
  return { rows: res.rows, durationMs: performance.now() - t0, observedAt };
}

// Sample rows are reduced by `redactRow` from `@ledar/contracts`. This file
// used to carry its own copy, which agreed with Layer B's copy on every case
// except the empty one: this one returned a real `null` and Layer B returned
// the string, and the store's guard accepted only the string. Nothing had
// broken yet — the sample query below selects only the foreign key's own
// columns and requires them all to be NOT NULL, so the branch was dead — which
// is exactly how a safety rule drifts out of step where nobody is looking.

/**
 * What Layer A found, and what it was able to look at while finding it.
 *
 * Two fields, and the second is not a summary of the first. `findings` are
 * claims; `rules` is the denominator each rule started from. They count
 * different things, and the difference is the whole of VS-4: the index rule
 * emits `1 of 1` on every invalid index it raises, so adding up the
 * `Coverage` carried by the findings counts findings. On a database with one
 * broken index among two hundred healthy ones that sum reads `1 of 1` —
 * true of the finding, and false of the work.
 *
 * The shape matches `LayerBOutcome` on purpose. `buildScopeStrip` adds the
 * two packs together, and a caller assembling one line out of two differently
 * shaped answers is a caller with somewhere to make a mistake.
 */
export type LayerAOutcome = {
  /**
   * `SealedFinding`, not `Finding`. Nothing in this file can build that type
   * — only `sealFindings` can — so every path out of `runLayerA` has been
   * through the gate, including any path a later change adds.
   */
  findings: SealedFinding[];

  /**
   * One entry per rule, all three of them, whether or not the rule had
   * anything to say.
   *
   * A rule that found nothing and a rule that never reached its targets
   * leave the same empty finding list, and this is what tells them apart.
   * Dropping the entry for a rule with nothing to report would leave
   * `buildScopeStrip` adding up a subset and printing it under the name of a
   * total — a smaller number that is not a smaller total.
   */
  rules: RuleCoverage[];
};

/**
 * Runs the three rules, and says what each of them was able to reach.
 *
 * The findings are `SealedFinding[]`, which is the enforcement: nothing in
 * this file can produce that type — `sealFindings` is the only thing that
 * can — so every path out of this function goes through the gate, including
 * any path a later change adds.
 *
 * The coverage returned beside them is the half that was missing. Layer B has
 * always stated its own denominator; Layer A stated one per finding and left
 * the caller to add those up, which counts findings rather than targets.
 */
export async function runLayerA(
  client: Client,
  graph: SchemaGraph,
  budget: QueryBudget,
): Promise<LayerAOutcome> {
  const drafts: FindingDraft[] = [];

  const unvalidatedFks = graph.constraints.filter(
    (c) => c.kind === 'foreign_key' && !c.validated && c.referencedTable,
  );
  const unvalidatedChecks = graph.constraints.filter(
    (c) => c.kind === 'check' && !c.validated,
  );

  // Judged one at a time, and counted while it happens.
  //
  // `graph.indexes.filter(...)` said exactly which indexes are broken and
  // nothing at all about how many were looked at — and every index here is
  // looked at, including each one that comes back healthy. A target examined
  // and let go is checked; the healthy indexes are the entire reason
  // `checked` and the number of findings differ for this rule.
  const brokenIndexes: IndexInfo[] = [];
  let indexesChecked = 0;
  for (const idx of graph.indexes) {
    indexesChecked += 1;
    if (!idx.isValid || !idx.isReady) brokenIndexes.push(idx);
  }

  const eligibleConstraints = unvalidatedFks.length + unvalidatedChecks.length;

  // Kept per rule, and joined further down for the claim that speaks for
  // both.
  //
  // One shared list could say how many constraints were missed and never
  // which rule missed them, so a scan that ran out of budget among the
  // foreign keys would file the hole against the CHECK rule as readily as
  // against its own. `buildScopeStrip` refuses when a rule's
  // `checked + notChecked` does not reach its `eligible`, and that catches
  // nothing unless the two rules are counted apart.
  const fkSkips: SkippedTarget[] = [];
  const checkSkips: SkippedTarget[] = [];
  /**
   * Broken indexes whose confirming query never came back.
   *
   * New with debt N27. This rule used to be unable to skip anything — it read
   * flags already in the graph and ran nothing — so its `notChecked` was a
   * hard-coded zero. Now that it confirms each broken index with a real
   * catalog query, it can be cut short by the budget or fail outright, and a
   * rule that can be cut short needs somewhere to say so.
   */
  const indexSkips: SkippedTarget[] = [];

  // Incremented where the examination happens, never derived as
  // `eligible - skipped`. Subtraction would make `checked + notChecked ===
  // eligible` true by construction, and the check `buildScopeStrip` runs
  // would then be arithmetic restating itself instead of a claim about what
  // this rule did.
  let fksChecked = 0;
  let checksChecked = 0;

  // ---- unvalidated foreign keys -----------------------------------------
  for (const fk of unvalidatedFks) {
    const fkTarget = `${fk.schema}.${fk.table}.${fk.name}`;
    if (!budget.canAfford(fkTarget)) {
      fkSkips.push({
        target: fkTarget,
        reason: 'the scan reached its ceiling on this database',
        cause: 'budget_ceiling',
      });
      continue;
    }

    let evidence: Evidence | null = null;
    // Null rather than a placeholder string. Every path that leaves the block
    // below without setting it also leaves this iteration, so the compiler
    // narrows it for the finding — whereas an empty-string default would
    // survive to the gate and have to be caught there, which is this repo's
    // oldest failure mode: a defensive default turning BROKEN into EMPTY.
    let observedAt: string | null = null;
    try {
      const counted = await timedQuery(client, buildOrphanQuery(fk));
      // Counted here, where the answer arrived — not at the bottom of the
      // loop. Everything below this line either raises a finding or lets the
      // constraint go, and both of those are the rule having looked.
      fksChecked += 1;
      observedAt = counted.observedAt;
      const orphans = Number(counted.rows[0]?.orphans ?? 0);
      budget.record(counted.durationMs, orphans);

      let sample: Record<string, unknown>[] = [];
      if (orphans > 0 && budget.canAfford(`${fkTarget} sample`)) {
        try {
          const s = await timedQuery(client, buildOrphanSampleQuery(fk));
          budget.record(s.durationMs, s.rows.length);
          sample = s.rows.map(redactRow);
        } catch {
          // A sample is a nicety. The count is not, and it already came back.
          //
          // This used to throw into the same catch as the count, and the
          // consequences were both wrong in the same direction: a constraint
          // that had been counted was filed as `query_failed` — reported as a
          // target nobody could read — and the finding built on that count
          // was dropped on the way out. It also double-counted this target
          // once coverage became per rule, checked *and* not checked, which
          // is the sum `buildScopeStrip` refuses. Layer B has always treated
          // its own sample this way.
        }
      }

      evidence = {
        sql: buildOrphanQuery(fk).trim(),
        rowCount: orphans,
        // `null`, not `sample.length`. This rule counts every orphan up to
        // its ceiling rather than estimating from a sample, so there is no
        // denominator to state — and how many example rows were kept is
        // `sample.length`, which is already here. Writing that number here
        // gave one field two meanings across the two packs.
        sampleSize: null,
        durationMs: counted.durationMs,
        sample,
      };

      if (orphans === 0) continue;
    } catch (err) {
      fkSkips.push({
        target: `${fk.schema}.${fk.table}.${fk.name}`,
        reason: err instanceof Error ? err.message : String(err),
        cause: 'query_failed',
      });
      continue;
    }

    const n = evidence.rowCount;
    const capped = n >= COUNT_LIMIT;
    const parent = `${fk.referencedSchema}.${fk.referencedTable}`;

    const finding: FindingDraft = {
      id: `layer-a/fk-orphans/${fk.schema}.${fk.table}.${fk.name}`,
      rule: FK_ORPHANS_RULE,
      kind: 'observation',
      confidence: 'certain',
      severity: 'high',

      // Counted, not sampled. `buildOrphanQuery` counts every orphan up to
      // COUNT_LIMIT rather than measuring a slice and multiplying, and when
      // it does hit that ceiling the sentence says "at least" and
      // `coverage.truncatedAt` says where it stopped. That is what entitles
      // this claim to `certain`: a number Postgres itself produced over the
      // whole population, not a rate carried outward from a sample.
      origin: 'counted',
      confidenceBasis: 'full_count',
      egressClass: EGRESS,
      observedAt,
      engineRuleVersion: LAYER_A_RULE_VERSION,
      schema: fk.schema,
      table: fk.table,
      columns: fk.columns,
      plainText:
        // Certain about the count. Not certain it is a problem — a reference
        // kept past its parent can be deliberate, and MusicBrainz is exactly
        // that case: its public dump removes private editor records on
        // purpose, leaving annotations pointing at people who are not there.
        // Stating the consequence as fact would have called that a defect.
        `${capped ? `At least ${n}` : `${n}`} ${n === 1 ? 'row' : 'rows'} in ` +
        `${fk.table} point at a ${fk.referencedTable} record that is not ` +
        `there. That part is certain — I counted it. Whether it matters is ` +
        `not: some systems keep references to records they removed on ` +
        `purpose. If this one does not, then anything following that link — ` +
        `a screen, a report, an export — has nothing to show for those rows.`,
      technical:
        `Foreign key ${fk.name} on ${fk.schema}.${fk.table} (${fk.columns.join(', ')}) ` +
        `→ ${parent} is NOT VALID, so Postgres never checked the rows that ` +
        `were already there. ${n}${capped ? '+' : ''} of them have no matching parent.`,
      evidence,
      coverage: {
        checked: 1,
        eligible: 1,
        skipped: [],
        truncatedAt: capped ? COUNT_LIMIT : null,
      },
    };

    drafts.push(finding);
  }

  // ---- unvalidated check constraints ------------------------------------
  for (const c of unvalidatedChecks) {
    const checkTarget = `${c.schema}.${c.table}.${c.name}`;
    if (!budget.canAfford(checkTarget)) {
      checkSkips.push({
        target: checkTarget,
        reason: 'the scan reached its ceiling on this database',
        cause: 'budget_ceiling',
      });
      continue;
    }
    try {
      const counted = await timedQuery(client, buildCheckViolationQuery(c));
      // Same place as the foreign key rule: the moment the answer arrived.
      // A constraint that comes back with zero violating rows was examined,
      // and letting it go is the result of having looked.
      checksChecked += 1;
      const bad = Number(counted.rows[0]?.violations ?? 0);
      budget.record(counted.durationMs, bad);
      if (bad === 0) continue;

      const capped = bad >= COUNT_LIMIT;
      const finding: FindingDraft = {
        id: `layer-a/check-violations/${c.schema}.${c.table}.${c.name}`,
        rule: CHECK_VIOLATED_RULE,
        kind: 'observation',
        confidence: 'certain',
        severity: 'high',

        // Same basis as the orphan rule, and for the same reason: the rows
        // that fail the CHECK are counted, up to COUNT_LIMIT, by a query the
        // finding carries. Nothing here is extrapolated, so nothing here
        // needs to be hedged.
        origin: 'counted',
        confidenceBasis: 'full_count',
        egressClass: EGRESS,
        observedAt: counted.observedAt,
        engineRuleVersion: LAYER_A_RULE_VERSION,
        schema: c.schema,
        table: c.table,
        columns: c.columns,
        plainText:
          `${capped ? `At least ${bad}` : `${bad}`} ${bad === 1 ? 'row' : 'rows'} ` +
          `in ${c.table} do not satisfy a rule the database was told to keep. ` +
          `New rows have to obey it; these were already there when the rule ` +
          `was added, and nobody went back to check them. Whether those rows ` +
          `are wrong or the rule arrived too late is yours to say.`,
        technical:
          `Constraint ${c.name} on ${c.schema}.${c.table} is NOT VALID. ` +
          `${bad}${capped ? '+' : ''} existing rows do not satisfy ${c.definition}.`,
        evidence: {
          sql: buildCheckViolationQuery(c).trim(),
          rowCount: bad,
          sampleSize: null,
          durationMs: counted.durationMs,
          sample: [],
        },
        coverage: {
          checked: 1,
          eligible: 1,
          skipped: [],
          truncatedAt: capped ? COUNT_LIMIT : null,
        },
      };

      drafts.push(finding);
    } catch (err) {
      checkSkips.push({
        target: `${c.schema}.${c.table}.${c.name}`,
        reason: err instanceof Error ? err.message : String(err),
        cause: 'query_failed',
      });
    }
  }

  // ---- indexes that are not enforcing anything --------------------------
  //
  // Debt N27. What used to be here published an `evidence` block for a
  // statement that had never been executed: `durationMs: 0`, `rowCount: 1`
  // written in by hand, and a SQL string assembled and then discarded. The
  // claim said "here is the query behind this number" about a query nothing
  // ran, which is the fault §4.1b names — declaring a measurement that did
  // not happen — sitting inside the one rule allowed to speak with certainty.
  //
  // `check:sql` passed it the whole time, and passed it honestly: that file
  // proves every fragment reaching a statement came from a sanitiser, and
  // this string never reached a statement at all. A check cannot see a query
  // that is never sent.
  //
  // So it is sent now. The flags are already in the graph, so this re-reads
  // what is known — and that is the cost of the sentence being true. Broken
  // indexes are rare (usually none), the query is one catalog row, and it
  // goes through the budget like everything else. When it cannot be afforded
  // or fails, the finding is not published: a claim about a query that did
  // not run is what this whole block exists to stop.
  for (const idx of brokenIndexes) {
    const indexTarget = `${idx.schema}.${idx.table}.${idx.name}`;
    if (!budget.canAfford(indexTarget)) {
      indexSkips.push({
        target: indexTarget,
        reason: 'the scan reached its ceiling on this database',
        cause: 'budget_ceiling',
      });
      continue;
    }

    // `quoteLiteral`, not an interpolated name. The name comes from the
    // catalog and an index called   o'brien   is legal, so the old
    // hand-assembled string would not even have parsed if it had ever run.
    const evidenceSql =
      `SELECT i.indisvalid, i.indisready FROM pg_index i ` +
      `JOIN pg_class ic ON ic.oid = i.indexrelid ` +
      `JOIN pg_namespace n ON n.oid = ic.relnamespace ` +
      `WHERE n.nspname = ${quoteLiteral(idx.schema)} ` +
      `AND ic.relname = ${quoteLiteral(idx.name)}`;

    let confirmed: { rows: Record<string, unknown>[]; durationMs: number };
    try {
      confirmed = await timedQuery(client, evidenceSql);
      budget.record(confirmed.durationMs, confirmed.rows.length);
    } catch (err) {
      budget.record(0, 0);
      indexSkips.push({
        target: indexTarget,
        reason: err instanceof Error ? err.message : String(err),
        cause: 'query_failed',
      });
      continue;
    }

    const finding: FindingDraft = {
      id: `layer-a/invalid-index/${idx.schema}.${idx.table}.${idx.name}`,
      rule: INDEX_NOT_ENFORCING_RULE,
      kind: 'observation',
      confidence: 'certain',
      severity: idx.isUnique ? 'high' : 'medium',

      // `catalog`, and no user row was touched to reach it: `indisvalid` and
      // `indisready` are flags Postgres keeps about itself, so the database
      // is the one asserting this and the claim is entitled to `certain`.
      //
      // The stamp is the moment this rule read those flags and judged them,
      // which is a little after `readSchemaGraph` actually fetched them.
      // Nothing hands that earlier instant over — a `SchemaGraph` carries no
      // read time — and inventing a closer-looking one would be worse than
      // recording the moment that is genuinely known. Both fall inside the
      // same scan; see the report note on this gap.
      origin: 'catalog',
      confidenceBasis: 'database_constraint',
      egressClass: EGRESS,
      observedAt: new Date().toISOString(),
      engineRuleVersion: LAYER_A_RULE_VERSION,
      schema: idx.schema,
      table: idx.table,
      columns: [],
      plainText: idx.isUnique
        ? `${idx.table} has a uniqueness rule that is switched off. Duplicates ` +
          `can be created right now and nothing will stop them.`
        : `An index on ${idx.table} was left half-built. Queries relying on it ` +
          `are reading the slow way.`,
      technical:
        `Index ${idx.name} on ${idx.schema}.${idx.table} has ` +
        `indisvalid=${idx.isValid}, indisready=${idx.isReady}. This is what a ` +
        `failed CREATE INDEX CONCURRENTLY leaves behind` +
        (idx.isUnique ? ', and the unique constraint is not being enforced.' : '.'),
      evidence: {
        sql: evidenceSql,
        // Both measured. `rowCount` is how many catalog rows came back, which
        // is 1 for an index that still exists and 0 for one dropped between
        // the graph read and this query — a difference the old hard-coded 1
        // could not express, and one worth being able to see.
        rowCount: confirmed.rows.length,
        sampleSize: null,
        durationMs: confirmed.durationMs,
        sample: [],
      },
      coverage: { checked: 1, eligible: 1, skipped: [], truncatedAt: null },
    };

    drafts.push(finding);
  }

  // ---- nothing found is a claim too -------------------------------------
  //
  // Two claims, not one. There used to be a single "nothing found" finding
  // whose sentence covered constraints *and* indexes while its denominator
  // counted constraints only — so on a database with no unvalidated
  // constraints and fifty healthy indexes it read "no index was left
  // invalid, across 0 eligible constraints", and the number a machine reads
  // said 0. A negative claim about indexes had been made against another
  // rule's denominator, which is the thing `Coverage` exists to prevent:
  // checked and skipped are recorded per rule, never globally.
  //
  // The claim speaks for both constraint rules at once, so it takes both
  // rules' skips — in the order they happened, the foreign keys having been
  // walked before the checks. The per-rule lists stay separate above; this is
  // the one sentence entitled to add them, because it is the one sentence
  // that names both rules.
  const skipped: SkippedTarget[] = [...fkSkips, ...checkSkips, ...indexSkips];

  if (drafts.length === 0) {
    const where = graph.schemas.join(', ');
    const byCeiling = skipped.filter((s) => s.cause === 'budget_ceiling').length;
    const unreadable = skipped.filter((s) => s.cause === 'query_failed').length;
    // Measured, not `eligibleConstraints - skipped.length`. The two agree
    // today and would go on agreeing after a change that made one of them
    // wrong, because subtraction cannot disagree with itself.
    const constraintsChecked = fksChecked + checksChecked;

    // ---- claim one: the constraints ---------------------------------------
    const tableCount = graph.tables.length;
    const constraintBoundary: string[] = [
      `Checked ${constraintsChecked} of ${eligibleConstraints} ` +
        `constraint${eligibleConstraints === 1 ? '' : 's'} that Postgres had ` +
        `not validated, in ${where}, across ${tableCount} readable ` +
        `table${tableCount === 1 ? '' : 's'}.`,
    ];

    // Said apart, because they are not the same news. Rolling both into
    // "ran out of budget" was a statement about cause that nothing measured,
    // and it hid the half that matters more.
    if (byCeiling > 0) {
      constraintBoundary.push(
        `${byCeiling} ${byCeiling === 1 ? 'was' : 'were'} not run at all — ` +
          `the scan reached its ceiling on this database.`,
      );
    }
    if (unreadable > 0) {
      constraintBoundary.push(
        `${unreadable} could not be read: the query failed. ` +
          `${unreadable === 1 ? 'That one is' : 'Those are'} not cleared, ` +
          `${unreadable === 1 ? 'it is' : 'they are'} unseen — and a table I ` +
          `cannot look inside is the one worth asking about.`,
      );
    }

    constraintBoundary.push(
      `Constraints Postgres already validated cannot be violated and were ` +
        `not re-checked. Nothing here says anything about rules that were ` +
        `never declared — that is a different question, and a harder one. ` +
        `Indexes are counted separately.`,
    );

    drafts.push({
      id: 'layer-a/none/constraints',
      rule: 'layer-a/no-declared-constraint-violations',
      // Debt N8. Reaching none of the constraints is not the same news as
      // reaching all of them and finding nothing, and `constraintPlainText`
      // has always said so in words — "I could not check any of the N
      // constraints in scope… That is not the same as nothing being wrong."
      // The field beside that sentence still said `negative`, which is what
      // a diff, a model, or a spreadsheet actually reads.
      //
      // A denominator of zero stays `negative`: "this database has no
      // unvalidated constraints" is a fact from the catalog, and the rule
      // looked at everything there was.
      kind:
        eligibleConstraints > 0 && constraintsChecked === 0 ? 'abstained' : 'negative',
      confidence: 'certain',
      severity: 'info',

      // Two situations wearing one sentence, and they did not come from the
      // same place.
      //
      // With constraints to check, every count above came back zero and each
      // was a full count, so this rests on the same basis they do. With none
      // to check, no query ran at all: the claim is "this database has no
      // unvalidated constraints", which is a fact read out of the catalog.
      // Declaring `full_count` there would describe a measurement that never
      // happened — the exact habit AGENTS.md §4.1b names, and one that costs
      // nothing to avoid because the branch is right here.
      //
      // Nothing downstream changes: both bases carry a ceiling of `certain`.
      // That is precisely why it would have gone unnoticed.
      origin: eligibleConstraints === 0 ? 'catalog' : 'counted',
      confidenceBasis:
        eligibleConstraints === 0 ? 'database_constraint' : 'full_count',
      egressClass: EGRESS,
      observedAt: new Date().toISOString(),
      engineRuleVersion: LAYER_A_RULE_VERSION,
      schema: where,
      table: '—',
      columns: [],
      // A different sentence per situation, because one sentence covering
      // all of them would have to be true of the weakest.
      plainText: constraintPlainText(eligibleConstraints, constraintsChecked),
      technical:
        `No unvalidated constraint had violating rows, across ` +
        `${constraintsChecked} of ${eligibleConstraints} eligible ` +
        `constraint${eligibleConstraints === 1 ? '' : 's'}. Indexes are a ` +
        `separate rule with its own denominator.`,
      boundary: constraintBoundary.join(' '),
      evidence: null,
      coverage: {
        // Not `eligibleConstraints`. Anything in `skipped` was never looked
        // at, and counting it as checked is how a scan that ran out of
        // budget halfway through comes to report full coverage.
        checked: constraintsChecked,
        eligible: eligibleConstraints,
        skipped: asCoverageSkips(skipped),
        truncatedAt: null,
      },
    });

    // ---- claim two: the indexes, with their own denominator ---------------
    //
    // Every index in the graph was judged, and judged from catalog flags
    // already read — no query, no budget, nothing skipped. So checked equals
    // eligible here honestly, which is exactly why it needs its own pair of
    // numbers rather than borrowing the constraint rule's.
    const eligibleIndexes = graph.indexes.length;

    drafts.push({
      id: 'layer-a/none/indexes',
      rule: 'layer-a/no-index-left-invalid',
      kind: 'negative',
      confidence: 'certain',
      severity: 'info',

      // `catalog`, like the finding it is the absence of. No data query was
      // run for this claim at all — which is exactly why it has its own pair
      // of coverage numbers rather than borrowing the constraint rule's, and
      // why nothing here was ever skipped for budget.
      //
      // Same stamping caveat as the invalid-index finding above: this is when
      // the flags were judged, not when `readSchemaGraph` read them.
      origin: 'catalog',
      confidenceBasis: 'database_constraint',
      egressClass: EGRESS,
      observedAt: new Date().toISOString(),
      engineRuleVersion: LAYER_A_RULE_VERSION,
      schema: where,
      table: '—',
      columns: [],
      plainText: indexPlainText(eligibleIndexes, where),
      technical:
        `${eligibleIndexes} index${eligibleIndexes === 1 ? '' : 'es'} in ` +
        `${where} report indisvalid and indisready true. Read from pg_index; ` +
        `no data was queried, so nothing was skipped for budget.`,
      boundary:
        (eligibleIndexes === 0
          ? `There were no indexes visible to this account in ${where}, so ` +
            `none were checked.`
          : eligibleIndexes === 1
            ? `Checked the one index this account can see in ${where}.`
            : `Checked all ${eligibleIndexes} indexes this account can see ` +
              `in ${where}.`) +
        ` Indexes on tables it cannot read are not in that number. And an ` +
        `index that is switched on is not necessarily the right index — ` +
        `whether the ones here are the ones you need is a different question, ` +
        `and not one this rule asks.`,
      evidence: null,
      coverage: {
        checked: eligibleIndexes,
        eligible: eligibleIndexes,
        skipped: [],
        truncatedAt: null,
      },
    });
  }

  // ---- what each rule was able to reach ---------------------------------
  //
  // Three entries, always all three, each in its own unit: foreign keys
  // Postgres had not validated, CHECK constraints Postgres had not validated,
  // and indexes this account can see. No target is counted by two of them,
  // which is what entitles `buildScopeStrip` to add them together.
  //
  // `ran` is true on all three, and it is true because this array is built
  // after all three loops have finished — there is no path that returns an
  // outcome without having executed them. A ceiling reached part way through
  // does not make it false: the rule ran and did not reach everything, which
  // is precisely what `notChecked` says. Saying the same thing twice in two
  // vocabularies gives the two somewhere to disagree, and the report has no
  // way to tell a reader which one to believe.
  const rules: RuleCoverage[] = [
    {
      rule: FK_ORPHANS_RULE,
      ran: true,
      eligible: unvalidatedFks.length,
      checked: fksChecked,
      notChecked: fkSkips.length,
    },
    {
      rule: CHECK_VIOLATED_RULE,
      ran: true,
      eligible: unvalidatedChecks.length,
      checked: checksChecked,
      notChecked: checkSkips.length,
    },
    {
      rule: INDEX_NOT_ENFORCING_RULE,
      ran: true,
      eligible: graph.indexes.length,
      // Every index the graph holds is judged on its flags, minus any whose
      // confirming query could not be run. The subtraction is what keeps
      // `checked + notChecked === eligible` true now that this rule has a
      // way to come up short.
      checked: indexesChecked - indexSkips.length,
      // This used to be a hard-coded zero, with a comment explaining that the
      // rule ran no query and therefore could not miss anything. That was
      // true, and it was true because the rule published evidence for a query
      // it never sent (N27). Confirming the flags for real bought the
      // sentence its honesty and cost it the guarantee — so the number is
      // measured now, like every other one here.
      //
      // Indexes on tables the role cannot read never reach the graph, so they
      // are outside this denominator rather than inside it and unchecked.
      notChecked: indexSkips.length,
    },
  ];

  return { findings: sealFindings(drafts, 'layer-a'), rules };
}

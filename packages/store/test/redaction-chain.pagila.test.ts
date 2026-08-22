/**
 * Rule 6, on values that actually came out of Postgres.
 *
 * The rule — no byte of real data leaves the user's machine outside a
 * redacted Evidence Pack — is enforced by three links, and each of them has
 * been tested on its own against rows somebody typed into a fixture:
 *
 *   1. the packs redact          redactCell / redactRow  (@ledar/contracts)
 *   2. the store refuses         assertSampleIsRedacted  (../src/identity.ts)
 *   3. the pack gate refuses     assertPackIsRedacted    (@ledar/contracts)
 *
 * Hand-built rows prove those three agree with what the author imagined. They
 * do not prove the three agree with each other about what a real scan
 * produces, and there is a specific reason to doubt it: `apps/cli/src/scan.ts`
 * pins `storeSamples: false`, so link 2 has never executed during a real scan.
 * The three redactors were merged out of three separate copies that had
 * silently disagreed about the empty cell for months — precisely because the
 * branch where they disagreed was dead. A dead branch is where safety rules
 * drift apart, and it is where they are found to have drifted.
 *
 * So this suite runs the real thing: connect to Pagila, run both packs, take
 * the findings they produce with their real `evidence.sample`, write them
 * through the store with `storeSamples: true` — the branch a real scan never
 * touches — and then read the resulting `.db` back as bytes.
 *
 * The hard part is not the byte scan. It is knowing what to search for. A
 * list of invented strings is absent from every file ever written, so a green
 * test built on one proves nothing at all. Every needle here is fetched out
 * of Pagila at run time, from the rows the finding is about, and the suite
 * refuses to pass if that list is empty, if the samples are empty, or if the
 * database is not there.
 *
 * WHICH SHAPES THIS COVERS  (HANDOFF-STATUS.md section 1c, debt N15)
 *
 * `redactCell` has four branches. Until damage 6 and 7 were added to
 * `fixture-damage.sql`, this suite only ever ran one of them: both orphan
 * columns in the fixture held integers, so every cell it followed through
 * the chain came out `<number>`. A suite that covers one branch of a
 * four-branch safety function reads, from the outside, exactly like a suite
 * that covers the function.
 *
 *   <number>   damaged_rental_note.rental_id · damaged_invoice.customer_id
 *   <text:N>   damaged_tag_link.damaged_tag_id
 *   <uuid>     damaged_asset_link.damaged_asset
 *   'null'     unreachable — both sample queries filter IS NOT NULL, and
 *              that filter is held shut by its own tests in the Layer A and
 *              Layer B suites. If a cell ever reduces to 'null' here, that
 *              branch has just gone live and this suite says so by name.
 *
 * WHICH REDACTOR RAN THEM  (debt N20)
 *
 * Covering the branches was not the whole of it. There are two entry points,
 * and the shapes above went in through one of them: Layer B reduces one cell
 * at a time with `redactCell`, and Layer A hands whole rows to `redactRow`.
 * Every orphan column Layer A had held integers, so the function the
 * fact-stating layer uses had only ever produced `<number>` on real data —
 * and `redactRow` is a loop, which with one-column samples had never gone
 * round twice.
 *
 * Damage 8 closes both: a composite NOT VALID foreign key over a text column
 * and a uuid column, so one Layer A sample row carries two cells of different
 * shapes. The per-pack assertion below is what keeps it closed; without it,
 * `<text:N>` appearing anywhere in the run reads as covered, no matter which
 * redactor produced it.
 *
 *   redactCell (layer B)  damaged_tag_link.damaged_tag_id      <text:N>
 *                         damaged_asset_link.damaged_asset     <uuid>
 *   redactRow  (layer A)  damaged_label_link.label_slug        <text:N>
 *                         damaged_label_link.label_key         <uuid>
 *
 * Which shape a column should produce is not read off the redactor. It is
 * read off the column's own Postgres type in the schema graph, so the
 * assertion is "an int4 column reduces to `<number>`", not "the redactor
 * did what the redactor does".
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { Client } from 'pg';
import {
  QueryBudget,
  disclosureFor,
  inspectPrivileges,
  qualified,
  quoteIdent,
  readSchemaGraph,
  readScope,
} from '@ledar/connector-postgres';
import type { Constraint, SchemaGraph } from '@ledar/connector-postgres';
import { assertScopeManifest } from '@ledar/contracts';
import type { Finding, ScopeManifest } from '@ledar/contracts';
import { buildOrphanSampleQuery, runLayerA } from '@ledar/packs-layer-a';
import { findCandidates, runImplicitForeignKeys } from '@ledar/packs-layer-b';
import type { ImplicitFkCandidate } from '@ledar/packs-layer-b';

import { ScanStore } from '../src/store.js';
import type { DatabaseIdentity } from '../src/types.js';

// One shared gate for every suite that needs the fixture, so the DSN and the
// list of damaged tables cannot drift apart across copies.
import {
  FIXTURE_SCHEMA,
  PAGILA_DSN,
  announceSkip,
  openPagila,
} from '@ledar/test-fixtures';

const SUITE = 'Rule 6 end to end: Pagila values through the packs into the store file';

/**
 * How many orphan rows this suite is willing to chase per finding.
 *
 * Not a sample. The point of fetching them is to hold the complete set of
 * values that could have leaked, so the suite also asserts it did not reach
 * this ceiling — a truncated needle list would let a value sit in the file
 * unsearched while the test still reported green.
 */
const ORPHAN_CEILING = 200;

/**
 * Which Layer B findings this suite can trace back to their rows, and why the
 * rest cannot be traced at all.
 *
 * The chase works by rebuilding the pack's sample query from outside the pack
 * and fetching every orphan row under `ORPHAN_CEILING`, so that proving those
 * values absent from the file proves the sample absent. Two of the fixtures
 * added for debts N33 and N34 break one of those requirements each, and
 * neither break is a defect — it is the chase running out of reach:
 *
 *   damaged_sentinel_link  the pack's sample query deliberately EXCLUDES the
 *                          repeated value it set aside, so a rebuilt query
 *                          that does not exclude it returns different rows.
 *                          The row-count guard would catch that, correctly,
 *                          and it would be catching this suite rather than
 *                          the product.
 *
 *   damaged_wide_link      18,000 orphans, which is two orders of magnitude
 *                          past ORPHAN_CEILING. A truncated needle list
 *                          cannot prove an absence, and a suite that pretends
 *                          otherwise is worse than one that says it cannot.
 *
 * Both lists are asserted against the real findings below. That is the part
 * that matters: a fixture added later lands in neither list and turns this
 * red, instead of quietly enlarging the set of things nobody checks. Silent
 * narrowing of a safety suite is how it goes from proving something to
 * proving nothing without anybody noticing.
 */
const LAYER_B_CHASED: readonly string[] = [
  'damaged_invoice',
  'damaged_tag_link',
  'damaged_asset_link',
  // One orphan, read in full, no value set aside — so the query rebuilds
  // faithfully and the needle list is one value long.
  'damaged_lonely_link',
];

const LAYER_B_OUT_OF_REACH: ReadonlyMap<string, string> = new Map([
  [
    'damaged_sentinel_link',
    'the pack excludes the value it set aside from its own sample, so this ' +
      'suite cannot rebuild the query that produced those rows',
  ],
  [
    'damaged_wide_link',
    'about 18,000 orphan rows, past ORPHAN_CEILING — the needle list would ' +
      'be truncated and an absence proved from it would prove nothing',
  ],
]);

/**
 * The pack's own sample limit, which neither pack exports.
 *
 * Copied so Layer B's sample query can be rebuilt here. The copy is not
 * trusted: `pinnedRows.length` is asserted equal to the number of rows the
 * finding actually redacted, so a limit that drifts fails loudly instead of
 * quietly narrowing what this suite looks for.
 */
const PACK_SAMPLE_LIMIT = 5;

/**
 * The shortest value this suite is prepared to prove absent by byte search.
 *
 * A one- or two-character value turns up by accident inside hashes,
 * timestamps and SQLite's own page headers, so its presence would say nothing
 * and its absence could not be arranged. If the fixture ever produces orphan
 * values that short, this suite has to fail and say so rather than search for
 * something it cannot tell apart from noise.
 */
const SHORTEST_PROVABLE = 4;

/**
 * What each Postgres type is supposed to reduce to.
 *
 * The oracle for the shape assertions, and deliberately not the redactor.
 * Postgres names the type; `redactCell` decides the shape; this table is the
 * contract between them, written down where it can be read. A redactor that
 * started emitting `<text:36>` for uuid columns would satisfy any check that
 * asked the redactor what it thought, and fails here.
 *
 * `<text:N>` stands for the whole family — the number in it is checked
 * separately, against the lengths of the real values it replaced.
 */
const SHAPE_FOR_TYPE: ReadonlyMap<string, string> = new Map([
  ['int2', '<number>'],
  ['int4', '<number>'],
  ['int8', '<number>'],
  ['text', '<text:N>'],
  ['varchar', '<text:N>'],
  ['bpchar', '<text:N>'],
  ['uuid', '<uuid>'],
]);

/**
 * Which of `redactCell`'s branches produced a cell, judged from the cell.
 *
 * Nothing here looks at the value the cell replaced, so this classifier
 * cannot agree with the redactor by construction the way a second copy of
 * the redactor would.
 */
function shapeFamily(cell: unknown): string {
  if (typeof cell !== 'string') return `not a string (${typeof cell})`;
  if (/^<text:\d+>$/.test(cell)) return '<text:N>';
  return cell;
}

/** The number inside `<text:N>`, or null for any other shape. */
function declaredLength(cell: unknown): number | null {
  if (typeof cell !== 'string') return null;
  const m = /^<text:(\d+)>$/.exec(cell);
  const digits = m === null ? undefined : m[1];
  return digits === undefined ? null : Number(digits);
}

/** One side of a reference, declared or merely suspected. */
type Link = {
  readonly childSchema: string;
  readonly childTable: string;
  readonly childColumns: readonly string[];
  readonly parentSchema: string;
  readonly parentTable: string;
  readonly parentColumns: readonly string[];
};

/** What was traced back to Pagila for one finding. */
type Chased = {
  readonly findingId: string;
  readonly pack: 'layer-a' | 'layer-b';
  readonly childTable: string;
  /** `schema.table.(columns)`, for failure messages. */
  readonly source: string;
  /** Exactly the rows the pack sampled, re-fetched with nothing redacted. */
  readonly pinnedRows: readonly Record<string, unknown>[];
  /** Every orphan row for that link — a superset of what the pack sampled. */
  readonly allRows: readonly Record<string, unknown>[];
  /** Those values as text: the needles. */
  readonly needles: readonly string[];
  /** How many redacted rows the finding carries. */
  readonly sampleSize: number;
  /**
   * The redacted rows themselves, still grouped as rows.
   *
   * Kept alongside the flattened cells because the width of a row is a claim
   * in its own right: `redactRow` is a loop over the cells of one row, and a
   * one-column sample cannot tell it apart from `redactCell` called once.
   */
  readonly redactedRows: readonly Record<string, unknown>[];
  /** The first redacted sample row, serialised the way the store stores it. */
  readonly redactedSlot: string;
  /**
   * Every redacted cell the finding carries, with the key it carries it
   * under. Layer A keeps the column name; Layer B renames its one column to
   * `orphan_value`, which is why the type lookup below has a fallback.
   */
  readonly redactedCells: readonly (readonly [string, unknown])[];
  /** The Postgres type of each child column, from the schema graph. */
  readonly columnTypes: ReadonlyMap<string, string>;
};

/**
 * The Postgres type behind one redacted cell.
 *
 * Falls back to the single child column when the key is not a column name,
 * which is Layer B renaming its one selected column to `orphan_value`. The
 * fallback is refused for a multi-column link rather than guessed at: a
 * composite key whose columns have different types would need this suite
 * extended, and quietly picking the first type would report a pass for a
 * comparison nobody made.
 */
function typeOfCell(c: Chased, key: string): string | undefined {
  const named = c.columnTypes.get(key);
  if (named !== undefined) return named;
  if (c.columnTypes.size === 1) return [...c.columnTypes.values()][0];
  return undefined;
}

/**
 * Every orphan child row for one link, with no redactor anywhere near it.
 *
 * A deliberate rebuild of what the packs query: the packs hand back redacted
 * rows and this suite needs the values underneath them. `quoteIdent` and
 * `qualified` are the same identifier quoting the packs use, so hard rule 5
 * holds here too — no identifier reaches SQL unquoted, in tests either.
 */
function orphanRowsSql(link: Link, limit: number): string {
  const child = qualified(link.childSchema, link.childTable);
  const parent = qualified(link.parentSchema, link.parentTable);

  const joinOn = link.childColumns
    .map((col, i) => {
      const ref = link.parentColumns[i];
      if (ref === undefined) throw new Error(`${link.childTable}: mismatched key width.`);
      return `c.${quoteIdent(col)} = p.${quoteIdent(ref)}`;
    })
    .join(' AND ');

  const notNull = link.childColumns
    .map((col) => `c.${quoteIdent(col)} IS NOT NULL`)
    .join(' AND ');

  const selected = link.childColumns.map((col) => `c.${quoteIdent(col)}`).join(', ');

  const firstParent = link.parentColumns[0];
  if (firstParent === undefined) throw new Error(`${link.parentTable}: no key columns.`);

  return `
    SELECT ${selected}
    FROM ${child} c
    LEFT JOIN ${parent} p ON ${joinOn}
    WHERE ${notNull} AND p.${quoteIdent(firstParent)} IS NULL
    LIMIT ${limit}
  `;
}

/** Every non-null cell of every row, as the text a leak would be made of. */
function cellsOf(rows: readonly Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (value === null || value === undefined) continue;
      out.push(String(value));
    }
  }
  return out;
}

/**
 * Where a needle landed, printable.
 *
 * A bare "the value is in the file" leaves the next reader unable to tell a
 * real leak from a run of digits that happened to fall inside a sha256. The
 * surrounding bytes settle it in one look, and printing them is safe: this
 * only ever runs against the throwaway fixture container.
 */
function excerptAround(haystack: string, needle: string): string {
  const at = haystack.indexOf(needle);
  if (at < 0) return '(not present)';
  const from = Math.max(0, at - 48);
  const to = Math.min(haystack.length, at + needle.length + 48);
  return `byte ${at}: ...${haystack.slice(from, to).replace(/[^ -~]/g, '.')}...`;
}

/** The declared foreign key a Layer A finding came from. */
function constraintBehind(f: Finding, graph: SchemaGraph): Constraint | undefined {
  return graph.constraints.find(
    (c) =>
      c.kind === 'foreign_key' &&
      `layer-a/fk-orphans/${c.schema}.${c.table}.${c.name}` === f.id,
  );
}

/** The suspected reference a Layer B finding came from. */
function candidateBehind(
  f: Finding,
  candidates: readonly ImplicitFkCandidate[],
): ImplicitFkCandidate | undefined {
  return candidates.find(
    (c) => `layer-b/implicit-fk/${c.childSchema}.${c.childTable}.${c.childColumn}` === f.id,
  );
}

async function rowsOf(client: Client, sql: string): Promise<Record<string, unknown>[]> {
  const res = await client.query(sql);
  return res.rows as Record<string, unknown>[];
}

/**
 * Traces one finding's sample back to the values it was made from.
 *
 * `pinnedRows` runs the pack's own sample query — for Layer A literally the
 * exported `buildOrphanSampleQuery` — so there is no question of chasing a
 * different relation than the finding is about. `allRows` drops the sample
 * limit, so the needle list is a superset of whatever the pack happened to
 * take: proving the superset absent proves the sample absent, without
 * depending on two unordered LIMIT queries choosing the same five rows.
 */
async function chase(
  client: Client,
  f: Finding,
  pack: 'layer-a' | 'layer-b',
  link: Link,
  pinnedSql: string,
  graph: SchemaGraph,
): Promise<Chased> {
  const pinnedRows = await rowsOf(client, pinnedSql);
  const allRows = await rowsOf(client, orphanRowsSql(link, ORPHAN_CEILING));

  const sample = f.evidence === null ? [] : f.evidence.sample;
  const firstRow = sample[0];

  const columnTypes = new Map<string, string>();
  for (const column of link.childColumns) {
    const info = graph.columns.find(
      (c) =>
        c.schema === link.childSchema && c.table === link.childTable && c.name === column,
    );
    if (info !== undefined) columnTypes.set(column, info.type);
  }

  return {
    findingId: f.id,
    pack,
    childTable: link.childTable,
    source: `${link.childSchema}.${link.childTable}.(${link.childColumns.join(', ')})`,
    pinnedRows,
    allRows,
    needles: [...new Set([...cellsOf(allRows), ...cellsOf(pinnedRows)])],
    sampleSize: sample.length,
    redactedRows: sample,
    redactedSlot: firstRow === undefined ? '' : JSON.stringify(firstRow),
    redactedCells: sample.flatMap(
      (row) => Object.entries(row) as [string, unknown][],
    ),
    columnTypes,
  };
}

/** Host and port as the fixture DSN spells them. Never the credential. */
function fixtureIdentity(database: string): DatabaseIdentity {
  const url = new URL(PAGILA_DSN);
  return {
    host: url.hostname,
    port: url.port === '' ? 5432 : Number(url.port),
    database,
  };
}

/** How many sample rows a finished history file actually kept. */
function sampleRowsKept(file: string, identity: DatabaseIdentity): number {
  const reopened = ScanStore.open(file);
  try {
    const runId = reopened.runsFor(identity)[0]?.runId;
    if (runId === undefined) return 0;
    return reopened
      .findingsOf(runId)
      .reduce((n, s) => n + (s.finding.evidence?.sample.length ?? 0), 0);
  } finally {
    reopened.close();
  }
}

const gate = await openPagila();

if (!gate.ok) {
  announceSkip(SUITE, gate.reason);

  // Registered as a skipped test rather than a skipped suite, so it lands in
  // the runner's "skipped" tally. A suite that vanishes from the totals reads
  // as "nothing to do here"; a skipped test reads as a hole.
  describe(SUITE, () => {
    it('rule 6 was not measured against real data', { skip: gate.reason }, () => {
      assert.fail('unreachable: this test is skipped');
    });
  });
} else {
  const client = gate.client;

  let findings: Finding[] = [];
  const chased: Chased[] = [];
  /** Every table Layer B raised, chased or not. Read by the accounting test. */
  let layerBTables: string[] = [];
  /** Whatever the store threw while being handed real samples, or null. */
  let storeError: Error | null = null;
  let bytes = '';
  let historyFile = '';
  let identity: DatabaseIdentity = fixtureIdentity('pagila');
  /** The manifest the run was opened with, kept so a control run can reuse it. */
  let storedScope: ScopeManifest | null = null;
  let tempDir: string | null = null;

  describe(SUITE, () => {
    before(async () => {
      const graph = await readSchemaGraph(client, [FIXTURE_SCHEMA]);
      assert.ok(
        graph.tables.length > 0,
        `no readable tables in ${FIXTURE_SCHEMA} — the role cannot see the fixture`,
      );

      // A full budget each, not the half-share the CLI hands out. A missing
      // sample has to mean the rule produced none, never that the scan ran out
      // of room before it reached the sample query.
      const layerA = (await runLayerA(client, graph, new QueryBudget())).findings;
      const layerB = await runImplicitForeignKeys(client, graph, new QueryBudget());
      findings = [...layerA, ...layerB.findings];

      for (const f of layerA) {
        if (f.evidence === null || f.evidence.sample.length === 0) continue;
        const fk = constraintBehind(f, graph);
        if (fk === undefined) continue;
        const { referencedSchema, referencedTable } = fk;
        if (referencedSchema === null || referencedTable === null) continue;
        chased.push(
          await chase(
            client,
            f,
            'layer-a',
            {
              childSchema: fk.schema,
              childTable: fk.table,
              childColumns: fk.columns,
              parentSchema: referencedSchema,
              parentTable: referencedTable,
              parentColumns: fk.referencedColumns,
            },
            buildOrphanSampleQuery(fk),
            graph,
          ),
        );
      }

      const candidates = findCandidates(graph);
      layerBTables = layerB.findings.map((f) => f.table);

      for (const f of layerB.findings) {
        if (f.evidence === null || f.evidence.sample.length === 0) continue;
        if (!LAYER_B_CHASED.includes(f.table)) continue;
        const c = candidateBehind(f, candidates);
        if (c === undefined) continue;
        const link: Link = {
          childSchema: c.childSchema,
          childTable: c.childTable,
          childColumns: [c.childColumn],
          parentSchema: c.parentSchema,
          parentTable: c.parentTable,
          parentColumns: [c.parentColumn],
        };
        // Layer B keeps its sample query private, so this is a rebuild. The
        // row-count assertion below is what catches the rebuild drifting.
        chased.push(
          await chase(
            client,
            f,
            'layer-b',
            link,
            orphanRowsSql(link, PACK_SAMPLE_LIMIT),
            graph,
          ),
        );
      }

      // The real scope of the real connection, not numbers typed into a
      // fixture. `openRun` cross-checks the manifest against the identity, so
      // a wrong database name here is refused rather than stored.
      const scopeReport = await readScope(client, [FIXTURE_SCHEMA]);
      const verdict = await inspectPrivileges(client, [FIXTURE_SCHEMA]);
      const scope: ScopeManifest = assertScopeManifest({
        database: scopeReport.database,
        role: scopeReport.role,
        schemas: scopeReport.schemasGranted,
        visibleTables: scopeReport.tablesReadable,
        totalTables: scopeReport.tablesInDatabase,
        grantedAt: scopeReport.grantedAt,
        readOnlyEnforcedByDatabase: verdict.kind === 'read_only_enforced',
        disclosure: disclosureFor(verdict),
      });

      identity = fixtureIdentity(scopeReport.database);
      storedScope = scope;

      tempDir = mkdtempSync(join(tmpdir(), 'ledar-rule6-'));
      historyFile = join(tempDir, 'history.db');

      const store = ScanStore.open(historyFile);
      const runId = store.openRun({
        database: identity,
        scope,
        // The whole reason this file exists. A real scan pins this to false
        // (apps/cli/src/scan.ts), which means the store's redaction guard has
        // never once run against what a pack actually produces.
        storeSamples: true,
      });

      try {
        store.recordFindings(runId, findings);
      } catch (err) {
        // Not rethrown. A refusal here is a real result about the chain and it
        // belongs in an assertion with a name, not in an exploded hook.
        storeError = err instanceof Error ? err : new Error(String(err));
      }

      const refusal: Error | null = storeError;
      store.finishRun(runId, {
        outcome: refusal === null ? 'completed' : 'failed',
        note: refusal === null ? null : `the store refused a sample: ${refusal.message}`,
        cost: { queries: 0, totalMs: 0, rowsScanned: 0 },
      });
      store.close();

      // latin1, so one byte reads as one character and the search cannot be
      // fooled by multi-byte decoding. Every value chased here is ASCII.
      bytes = readFileSync(historyFile, 'latin1');
    });

    after(async () => {
      await client.end().catch(() => undefined);
      if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true });
    });

    // ── there has to be something to prove ───────────────────────────────
    //
    // Everything further down is an absence claim, and an absence claim over
    // an empty set is the cheapest green in software. These two run first, so
    // a suite holding nothing fails instead of congratulating itself.

    it('both packs handed over real sample rows', () => {
      const withSamples = findings.filter(
        (f) => f.evidence !== null && f.evidence.sample.length > 0,
      );
      assert.ok(
        withSamples.length > 0,
        `not one of the ${findings.length} Pagila findings carries a sample ` +
          `row. There is then nothing redacted to look for, and every absence ` +
          `assertion below would pass over an empty set. Findings seen: ` +
          `${findings.map((f) => f.id).join(', ') || '(none)'}`,
      );

      for (const pack of ['layer-a', 'layer-b'] as const) {
        assert.ok(
          chased.some((c) => c.pack === pack && c.sampleSize > 0),
          `${pack} produced no finding with sample rows, so this suite proves ` +
            `nothing about what ${pack} hands the store. Traced: ` +
            `${chased.map((c) => `${c.findingId}(${c.sampleSize})`).join(', ') || '(none)'}`,
        );
      }
    });

    it('every Layer B finding is either chased or declared out of reach', () => {
      const reported = layerBTables;
      assert.ok(
        reported.length > 0,
        'Layer B produced no findings at all, so this suite is proving ' +
          'nothing about Layer B values today.',
      );

      const unaccounted = reported.filter(
        (t) => !LAYER_B_CHASED.includes(t) && !LAYER_B_OUT_OF_REACH.has(t),
      );
      assert.deepEqual(
        unaccounted,
        [],
        `Layer B reported findings on ${unaccounted.join(', ')}, which appear ` +
          `in neither LAYER_B_CHASED nor LAYER_B_OUT_OF_REACH. A new fixture ` +
          `has to be a decision — either its values are proved absent from the ` +
          `file, or the reason they cannot be is written down. Falling through ` +
          `silently shrinks what this suite proves without changing what it ` +
          `claims.`,
      );

      const missing = LAYER_B_CHASED.filter((t) => !reported.includes(t));
      assert.deepEqual(
        missing,
        [],
        `${missing.join(', ')} is listed as chased but produced no finding, so ` +
          `the chase below covers less than it says. This is the failure mode ` +
          `where a suite keeps passing while quietly testing less.`,
      );

      const chasedTables = chased.filter((c) => c.pack === 'layer-b').map((c) => c.childTable);
      assert.deepEqual(
        [...chasedTables].sort(),
        [...LAYER_B_CHASED].sort(),
        'the findings actually traced do not match the ones declared',
      );
    });

    it('the values behind those samples were traced back to Pagila', () => {
      assert.ok(chased.length > 0, 'no finding could be traced back to its rows');

      for (const c of chased) {
        assert.equal(
          c.pinnedRows.length,
          c.sampleSize,
          `${c.findingId}: the pack redacted ${c.sampleSize} rows, but its own ` +
            `sample query returns ${c.pinnedRows.length} from ${c.source}. The ` +
            `needles would then be values from rows this finding is not about, ` +
            `and an absence proved about the wrong rows proves nothing.`,
        );

        assert.ok(
          c.allRows.length < ORPHAN_CEILING,
          `${c.source} has at least ${ORPHAN_CEILING} orphan rows, so the ` +
            `needle list is truncated and a value outside it could sit in the ` +
            `file unsearched.`,
        );

        assert.ok(
          c.needles.length > 0,
          `${c.findingId}: nothing came back from ${c.source}. The finding ` +
            `claims orphans; the database says there are none.`,
        );

        for (const needle of c.needles) {
          assert.ok(
            needle.length >= SHORTEST_PROVABLE,
            `${c.source} holds the orphan value "${needle}", which is too short ` +
              `to prove absent by byte search — a run that short turns up inside ` +
              `hashes and page headers by chance. This suite cannot honestly ` +
              `cover a value like that; it would need a different technique.`,
          );
        }
      }
    });

    // ── link 2, on the branch a real scan never reaches ──────────────────

    it('the store accepts, with samples on, exactly what the packs produced', () => {
      const refusal: Error | null = storeError;
      assert.ok(
        refusal === null,
        `the store refused a sample the packs built out of real Pagila rows. ` +
          `That is two links of rule 6 disagreeing, which unit tests on ` +
          `hand-written rows could not see: ${refusal?.message ?? ''}`,
      );

      const kept = sampleRowsKept(historyFile, identity);

      // Counted over EVERY finding written, not over the chased subset. The
      // two were the same number until findings appeared that this suite
      // cannot trace back to their rows (see LAYER_B_OUT_OF_REACH), and
      // leaving it counting `chased` would have quietly turned a check on the
      // whole write path into a check on part of it — while still reading as
      // "exactly what the packs produced".
      const offered = findings.reduce(
        (n, f) => n + (f.evidence === null ? 0 : f.evidence.sample.length),
        0,
      );
      assert.equal(
        kept,
        offered,
        `${offered} redacted sample rows were handed to the store and ${kept} ` +
          `came back out. With storeSamples on, a sample that goes in has to ` +
          `come out, or the write path and the read path disagree about what a ` +
          `sample is.`,
      );
    });

    it('the redacted sample reached the file, in the slot a real value would occupy', () => {
      for (const c of chased) {
        assert.notEqual(c.redactedSlot, '', `${c.findingId} carried no sample row`);
        assert.ok(
          bytes.includes(c.redactedSlot),
          `${c.findingId}: ${c.redactedSlot} is not in the history file. The ` +
            `sample never landed, so the absence of real values below is the ` +
            `absence of the whole sample and says nothing about redaction.`,
        );
      }
    });

    // ── which of redactCell's four branches actually ran ─────────────────

    it('every redacted cell is the shape its column type calls for', () => {
      let examined = 0;

      for (const c of chased) {
        assert.ok(
          c.redactedCells.length > 0,
          `${c.findingId} carries no redacted cells, so nothing is measured here`,
        );

        for (const [key, cell] of c.redactedCells) {
          const pgType = typeOfCell(c, key);
          assert.ok(
            pgType !== undefined,
            `${c.findingId}: cannot tell which column "${key}" came from. The ` +
              `link has ${c.columnTypes.size} columns ` +
              `(${[...c.columnTypes.keys()].join(', ')}), so the single-column ` +
              `fallback does not apply. This suite needs extending before it ` +
              `can claim anything about a composite key of mixed types.`,
          );

          const expected = SHAPE_FOR_TYPE.get(pgType);
          assert.ok(
            expected !== undefined,
            `${c.findingId}: ${key} is a ${pgType} column, and this suite holds ` +
              `no expectation for that type. Add it to SHAPE_FOR_TYPE rather ` +
              `than letting it through — a type nobody wrote down is exactly ` +
              `where a redactor falls into its default branch unnoticed.`,
          );

          assert.equal(
            shapeFamily(cell),
            expected,
            `${c.findingId}: ${key} is a ${pgType} column and its sampled cell ` +
              `is ${JSON.stringify(cell)}. Postgres says what the value was and ` +
              `the redactor says what it became; the two no longer agree.`,
          );
          examined += 1;
        }
      }

      assert.ok(examined > 0, 'no redacted cell was examined, so this proved nothing');
    });

    it('all three reachable shapes came from real rows, and the fourth did not', () => {
      const produced = new Map<string, string[]>();
      for (const c of chased) {
        for (const [, cell] of c.redactedCells) {
          const family = shapeFamily(cell);
          const from = produced.get(family) ?? [];
          if (!from.includes(c.source)) from.push(c.source);
          produced.set(family, from);
        }
      }

      for (const family of ['<number>', '<text:N>', '<uuid>'] as const) {
        assert.ok(
          produced.has(family),
          `nothing in this run reduced to ${family}, so that branch of ` +
            `redactCell is once again covered only by values somebody typed ` +
            `into a unit test. Shapes that did run: ` +
            `${[...produced.keys()].join(', ') || '(none)'}. The columns meant ` +
            `to produce it are damage 6 and 7 in ` +
            `packages/packs-layer-a/test/fixture-damage.sql; if they are ` +
            `missing from the container, the fixture gate should have skipped ` +
            `this suite rather than let it run.`,
        );
      }

      assert.equal(
        produced.has('null'),
        false,
        `a sampled cell was empty, which means redactCell's null branch has ` +
          `run on real data for the first time — from ` +
          `${(produced.get('null') ?? []).join(', ')}. Both sample queries are ` +
          `supposed to make that impossible by filtering IS NOT NULL. That ` +
          `branch is the one three copies of this redactor disagreed about, ` +
          `and nothing downstream has ever been checked against it. Do not ` +
          `absorb this failure: check the store's guard and the Evidence Pack ` +
          `gate against an empty cell first.`,
      );
    });

    // ── which of the two redactors ran them  (debt N20) ──────────────────
    //
    // The test above proves the three reachable shapes came from real rows.
    // It does not say through which door. Layer B calls `redactCell` on one
    // cell; Layer A calls `redactRow` on a whole row, and until damage 8 the
    // only real values Layer A ever handed it were integers — so a run could
    // satisfy every shape assertion above with `redactRow` still covering one
    // branch of four.
    //
    // Both of these read their expectation off the columns' Postgres types.
    // Asking the redactor what it thinks a uuid becomes would agree with
    // itself no matter what it did.

    it("Layer A's row-wise redactor produced every shape its columns call for", () => {
      const layerA = chased.filter((c) => c.pack === 'layer-a');
      assert.ok(
        layerA.length > 0,
        `no Layer A finding was traced back to its rows, so nothing here says ` +
          `anything about redactRow. Traced: ` +
          `${chased.map((c) => `${c.findingId}(${c.pack})`).join(', ') || '(none)'}`,
      );

      const expected = new Set<string>();
      for (const c of layerA) {
        for (const [column, pgType] of c.columnTypes) {
          const shape = SHAPE_FOR_TYPE.get(pgType);
          assert.ok(
            shape !== undefined,
            `${c.source}: ${column} is a ${pgType} column and this suite holds ` +
              `no expectation for that type. Add it to SHAPE_FOR_TYPE rather ` +
              `than letting it through — a type nobody wrote down is exactly ` +
              `where a redactor falls into its default branch unnoticed.`,
          );
          expected.add(shape);
        }
      }

      assert.ok(
        [...expected].some((shape) => shape !== '<number>'),
        `every column Layer A sampled here is an integer column, so redactRow ` +
          `has once again only ever produced <number> from a value that came ` +
          `out of Postgres — that is debt N20, reopened. Damage 8 in ` +
          `packages/packs-layer-a/test/fixture-damage.sql exists so that it ` +
          `does not: a NOT VALID foreign key over a text column and a uuid ` +
          `column. Types Layer A actually sampled: ` +
          `${[...new Set(layerA.flatMap((c) => [...c.columnTypes.values()]))].sort().join(', ')}.`,
      );

      const produced = new Set(
        layerA.flatMap((c) => c.redactedCells.map(([, cell]) => shapeFamily(cell))),
      );

      assert.deepEqual(
        [...produced].sort(),
        [...expected].sort(),
        `the columns Layer A sampled call for ${[...expected].sort().join(', ')} ` +
          `and redactRow produced ${[...produced].sort().join(', ')}. Postgres ` +
          `says what the values were and the row-wise redactor says what they ` +
          `became; the two no longer line up.`,
      );
    });

    it('a sampled row wider than one cell went through redactRow whole', () => {
      const composite = chased.filter((c) => c.pack === 'layer-a' && c.columnTypes.size > 1);

      assert.ok(
        composite.length > 0,
        `every Layer A link traced here is one column wide. At that width ` +
          `redactRow and a single call to redactCell are indistinguishable — ` +
          `the loop that is the only thing redactRow adds has never gone round ` +
          `twice on real data. Damage 8 in ` +
          `packages/packs-layer-a/test/fixture-damage.sql is a composite key ` +
          `so that it does. Widths seen: ` +
          `${chased.filter((c) => c.pack === 'layer-a').map((c) => `${c.source}=${c.columnTypes.size}`).join(', ') || '(none)'}.`,
      );

      let mixedRows = 0;

      for (const c of composite) {
        const wanted = new Set<string>();
        for (const pgType of c.columnTypes.values()) {
          const shape = SHAPE_FOR_TYPE.get(pgType);
          assert.ok(shape !== undefined, `${c.source}: no expectation for ${pgType}`);
          wanted.add(shape);
        }

        assert.ok(c.redactedRows.length > 0, `${c.findingId} carried no sample rows`);

        for (const row of c.redactedRows) {
          assert.deepEqual(
            Object.keys(row).sort(),
            [...c.columnTypes.keys()].sort(),
            `${c.findingId}: a redacted row carries ` +
              `${JSON.stringify(Object.keys(row))} for a key of ` +
              `(${[...c.columnTypes.keys()].join(', ')}). A cell that is not in ` +
              `the row is a cell nobody reduced, and one that should not be ` +
              `there came from somewhere this suite cannot type-check.`,
          );

          const got = new Set(Object.values(row).map(shapeFamily));
          assert.deepEqual(
            [...got].sort(),
            [...wanted].sort(),
            `${c.findingId}: the key columns are ` +
              `(${[...c.columnTypes.values()].join(', ')}), which call for ` +
              `${[...wanted].sort().join(', ')}, and the row reduced to ` +
              `${[...got].sort().join(', ')}. redactRow has to decide per cell; ` +
              `one shape for a whole row means it stopped doing that.`,
          );

          if (wanted.size > 1) mixedRows += 1;
        }
      }

      assert.ok(
        mixedRows > 0,
        `no sampled row mixed two different shapes, so redactRow could have ` +
          `been applying one decision to the whole row and this suite would ` +
          `not know. The composite key in damage 8 pairs a text column with a ` +
          `uuid column precisely so that one row forces two branches.`,
      );
    });

    it('a <text:N> states the length of the value it replaced, and nothing more', () => {
      let compared = 0;

      for (const c of chased) {
        const realLengths = new Set(c.needles.map((n) => n.length));

        for (const [key, cell] of c.redactedCells) {
          const stated = declaredLength(cell);
          if (stated === null) continue;

          assert.ok(
            realLengths.has(stated),
            `${c.findingId}: ${key} was redacted to ${JSON.stringify(cell)}, but ` +
              `no orphan value in ${c.source} is ${stated} characters long ` +
              `(lengths present: ` +
              `${[...realLengths].sort((a, b) => a - b).join(', ')}). The number ` +
              `is the one thing that survives redaction, so it has to be the ` +
              `length of a value that was really there — otherwise the shape ` +
              `is describing something else.`,
          );
          compared += 1;
        }
      }

      assert.ok(
        compared > 0,
        `not one cell reduced to <text:N>, so this comparison ran over an empty ` +
          `set. Damage 6 in the fixture exists so that it does not.`,
      );
    });

    // ── the claim rule 6 actually makes ──────────────────────────────────

    it('no real Pagila value is anywhere in the history file', () => {
      let searched = 0;
      /** How many needles were searched per shape the column redacts to. */
      const perShape = new Map<string, number>();

      for (const c of chased) {
        const families = new Set(
          [...c.columnTypes.values()].map(
            (t) => SHAPE_FOR_TYPE.get(t) ?? `unrecorded type ${t}`,
          ),
        );

        for (const needle of c.needles) {
          searched += 1;
          for (const family of families) {
            perShape.set(family, (perShape.get(family) ?? 0) + 1);
          }
          assert.ok(
            !bytes.includes(needle),
            `a real value from ${c.source} is in the history file: "${needle}" ` +
              `(${excerptAround(bytes, needle)}). Rule 6 says no byte of real ` +
              `data leaves the machine outside a redacted Evidence Pack, and a ` +
              `history file is exactly the file people attach to bug reports.`,
          );
        }
      }

      assert.ok(searched > 0, 'no value was searched for, so this proved nothing');

      // An absence proved only over integers is an absence proved over one of
      // three shapes. Text and uuid values are longer, more distinctive, and
      // the ones a leak would be embarrassing about — they have to be among
      // what was actually looked for, not merely among what was redacted.
      for (const family of ['<number>', '<text:N>', '<uuid>'] as const) {
        assert.ok(
          (perShape.get(family) ?? 0) > 0,
          `no real value from a column that redacts to ${family} was searched ` +
            `for in the history file. Searched by shape: ` +
            `${[...perShape].map(([k, n]) => `${k}=${n}`).join(', ') || '(nothing)'}.`,
        );
      }
    });

    it('the same search does find those values when nothing redacts them', () => {
      // The control on the test above. Its needles are worth something only
      // if they are findable at all — so serialise the un-redacted rows the
      // way the store serialises a sample, and require every needle to turn
      // up. Without this, an absence could be the absence of a search.
      for (const c of chased) {
        const unredacted = JSON.stringify(c.allRows);
        for (const needle of c.needles) {
          assert.ok(
            unredacted.includes(needle),
            `"${needle}" cannot be found even in the raw rows it came from, so ` +
              `searching the history file for it measured nothing.`,
          );
        }
      }
    });

    it('this search catches a real value that arrives through an unguarded column', () => {
      // The second control, and the one that answers principle 10 for the
      // absence test above.
      //
      // Break `redactCell` and the store's own guard throws, the transaction
      // rolls back, and nothing is written — so the absence test goes green
      // over an empty file, having proved nothing. That guard only watches
      // `evidence.sample`. `technical`, `plainText` and `evidence.sql` are
      // written verbatim and nothing inspects them, and Layer A's skip reason
      // is already a Postgres error message, which quotes offending values
      // into its own text ("Key (email)=(...) already exists"). Those columns
      // are the leak this byte scan exists for, and they are the reason it is
      // not a duplicate of the guard.
      //
      // So: write a real Pagila value into one of them, through the real
      // store, into a real file, and require the search to find it. The
      // sample is emptied first, so this control does not depend on the
      // redactor it is meant to be independent of.
      //
      // One value per redaction shape, rather than whichever finding was
      // traced first. That used to be an integer, and an integer needle only
      // proves this search can find a run of digits. Whether a 36-character
      // uuid or a hyphenated slug would be found is a separate question, and
      // those are exactly the two shapes the suite only began to cover with
      // damage 6 and 7.
      const familyOf = (c: Chased): string =>
        [
          ...new Set(
            [...c.columnTypes.values()].map(
              (t) => SHAPE_FOR_TYPE.get(t) ?? `unrecorded type ${t}`,
            ),
          ),
        ].join('+');

      const representative = new Map<string, Chased>();
      for (const c of chased) {
        const family = familyOf(c);
        if (!representative.has(family)) representative.set(family, c);
      }

      const planted: Finding[] = [];
      const wanted: { family: string; needle: string; source: string }[] = [];

      for (const family of ['<number>', '<text:N>', '<uuid>'] as const) {
        const traced = representative.get(family);
        assert.ok(
          traced !== undefined,
          `no traced finding holds values that redact to ${family}, so this ` +
            `control cannot say whether the byte search would find one. ` +
            `Available: ${[...representative.keys()].join(', ') || '(none)'}.`,
        );

        const needle = traced.needles[0];
        assert.ok(needle !== undefined, `${traced.source} produced no value to plant`);

        const original = findings.find((f) => f.id === traced.findingId);
        assert.ok(original !== undefined, `${traced.findingId} vanished from the findings`);

        planted.push({
          ...original,
          id: `${original.id}#byte-search-control`,
          technical: `${original.technical} [control] value ${needle}`,
          evidence:
            original.evidence === null ? null : { ...original.evidence, sample: [] },
        });
        wanted.push({ family, needle, source: traced.source });
      }

      const scope = storedScope;
      assert.ok(scope !== null, 'the run never opened, so there is no scope to reuse');

      const dir = mkdtempSync(join(tmpdir(), 'ledar-rule6-control-'));
      try {
        const file = join(dir, 'control.db');
        const store = ScanStore.open(file);
        const runId = store.openRun({ database: identity, scope, storeSamples: true });
        store.recordFindings(runId, planted);
        store.finishRun(runId, {
          outcome: 'completed',
          cost: { queries: 0, totalMs: 0, rowsScanned: 0 },
        });
        store.close();

        const controlBytes = readFileSync(file, 'latin1');
        for (const { family, needle, source } of wanted) {
          assert.ok(
            controlBytes.includes(needle),
            `a real ${family} value from ${source} was written into ` +
              `"technical" and this search did not find it. Then the file scan ` +
              `above is looking in the wrong place for values of that shape, ` +
              `and its green says nothing about whether the history file is ` +
              `clean of them.`,
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // ── the other direction: redacting too much is also a break ──────────

    it('redaction did not eat the names a report has to be able to say', () => {
      for (const c of chased) {
        assert.ok(
          bytes.includes(c.childTable),
          `the table name ${c.childTable} is not in the history file. A history ` +
            `that cannot name the table it is about is unreadable to anyone.`,
        );
      }

      // Named outright rather than derived, because these are what the
      // fixture exists for, and a derivation that quietly produced an empty
      // list would take the loop above down with it in silence.
      assert.match(bytes, /damaged_rental_note/, 'the Layer A table is missing');
      assert.match(bytes, /rental_id/, 'the Layer A column is missing');
      assert.match(bytes, /damaged_invoice/, 'the Layer B table is missing');
      assert.match(bytes, /customer_id/, 'the Layer B column is missing');
      assert.match(bytes, /damaged_tag_link/, 'the <text:N> table is missing');
      assert.match(bytes, /damaged_tag_id/, 'the <text:N> column is missing');
      assert.match(bytes, /damaged_asset_link/, 'the <uuid> table is missing');
      assert.match(bytes, /damaged_asset/, 'the <uuid> column is missing');
      // Damage 8: the Layer A side of <text:N> and <uuid>, one row, two cells.
      assert.match(bytes, /damaged_label_link/, 'the composite-key table is missing');
      assert.match(bytes, /label_slug/, 'the redactRow <text:N> column is missing');
      assert.match(bytes, /label_key/, 'the redactRow <uuid> column is missing');
    });
  });
}

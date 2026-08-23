/**
 * Runs both layers and prints what came back.
 *
 * The two layers are printed apart on purpose. Layer A states facts the
 * database itself will confirm. Layer B asks questions it cannot answer
 * alone. Mixing them into one list would be the quickest way to teach
 * someone that the confident half is as soft as the uncertain half — or
 * worse, the other way round.
 *
 * Everything printed is bracketed by two things that are not findings: the
 * scope manifest above it, which says what was looked at, and the history
 * line below it, which says whether any of this was written down. Both are
 * printed whether or not they have good news.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  connectReadOnly,
  describeScope,
  disclosureFor,
  inspectPrivileges,
  probeEmptyTables,
  QueryBudget,
  readSchemaGraph,
  readScope,
} from '@ledar/connector-postgres';
import type {
  BudgetSpend,
  PrivilegeVerdict,
  ScopeReport,
} from '@ledar/connector-postgres';
import {
  assertScopeManifest,
  buildScopeStrip,
  scopeStripByRule,
  scopeCoverageSentence,
  scopeStripLine,
  reportVerdict,
} from '@ledar/contracts';
import type { Coverage, Finding, ScopeManifest } from '@ledar/contracts';
import { runLayerA } from '@ledar/packs-layer-a';
import {
  IMPLICIT_FK_RULE,
  runImplicitForeignKeys,
  semanticQuestionFor,
} from '@ledar/packs-layer-b';
import type {
  DatabaseIdentity,
  OpenedHistory,
  RetiredHistory,
  RuleRun,
  ScanStore,
} from '@ledar/store';

import { ledarDir } from './paths.js';
import { wrap } from './text.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
/**
 * Which schemas to look at.
 *
 * `public` by default because that is where an application's own tables
 * normally live, but plenty of real databases put them elsewhere —
 * MusicBrainz uses `musicbrainz`, and Supabase keeps its internals in
 * `auth` and `storage` where this has no business looking.
 */
const SCHEMAS = (process.env.LEDAR_SCHEMAS ?? 'public')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * The Layer B rule id, taken from the pack that owns it.
 *
 * Used for one case only: recording that the rule ran when it found nothing,
 * where there is no finding to read the id off. This was a copied string
 * until the pack exported the constant — a copy that would have gone stale on
 * the first rename, growing a rule in the history that never ran.
 */
const LAYER_B_RULE = IMPLICIT_FK_RULE;

function readDsn(): string {
  if (process.env.TEST_PG_DSN) return process.env.TEST_PG_DSN;
  const text = readFileSync(resolve(REPO, 'infra/.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*TEST_PG_DSN\s*=\s*(.+)$/.exec(line);
    if (m?.[1]) return m[1].trim();
  }
  throw new Error('infra/.env has no TEST_PG_DSN. Run infra/set-secret.cmd.');
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- scope -----------------------------------------------------------------

/**
 * The connector's scope report, in the shape the contracts package validates.
 *
 * One line here needed a decision, and it is `totalTables`. The obvious wiring
 * — hand it `tablesInRequestedSchemas` — compiles, reads naturally, and is a
 * lie: that number counts tables in the schemas this scan was pointed at, so
 * on a Supabase project it renders as "35 of 35 tables — all of them" about a
 * database holding 76. It is the same substitution as `GREATEST(reltuples, 0)`
 * reporting "nobody has run ANALYZE" as "0 rows", which this project has
 * already been bitten by once.
 *
 * So the manifest gets the number that was actually measured across the whole
 * database, and `visibleTables` stays what the scan could read inside the
 * schemas it was given. Numerator: coverage. Denominator: existence. Neither
 * is inferred from the other.
 *
 * `schemas` is the *granted* list rather than the requested one, because a
 * schema that was asked for and refused was not in scope no matter what the
 * command line said.
 */
function manifestFrom(
  scope: ScopeReport,
  verdict: PrivilegeVerdict,
): ScopeManifest {
  return {
    database: scope.database,
    role: scope.role,
    schemas: scope.schemasGranted,
    visibleTables: scope.tablesReadable,
    totalTables: scope.tablesInDatabase,
    grantedAt: scope.grantedAt,
    readOnlyEnforcedByDatabase: verdict.kind === 'read_only_enforced',
    disclosure: disclosureFor(verdict),
  };
}

// ---- history ---------------------------------------------------------------

/**
 * Where the scan history file lives.
 *
 * Never inside the repository and never in the working directory. A history
 * is a record of somebody's databases; a file that lands wherever the terminal
 * happened to be is a file that gets committed by accident. `LEDAR_HISTORY_DB`
 * names one explicitly, which is what the test suite uses so it can read the
 * history back without touching the operator's own.
 */
function historyFile(): string {
  const named = process.env.LEDAR_HISTORY_DB?.trim();
  if (named) return resolve(named);

  // The three platform branches used to be written out here as well as in
  // `export-evidence.ts`. Two copies of one rule, and the copies were guarded
  // unevenly: that one grew property tests, this one had none, because every
  // scan test sets LEDAR_HISTORY_DB and never reaches this line. The unguarded
  // copy is always the one that drifts.
  return join(ledarDir(), 'history.db');
}

/**
 * Which database this run belongs to, without the parts that unlock it.
 *
 * `new URL` is the redaction: only `hostname` and `port` are read back out of
 * it, so the password never leaves this function. The database name comes from
 * `current_database()` rather than from the DSN path — they can disagree, and
 * the server's answer is the true one.
 *
 * Returns null rather than a guess. Two databases filed under one identity
 * merge into a single timeline, and the diff drawn across that seam would be
 * confidently wrong about every finding in it.
 */
function identityFrom(dsn: string, database: string): DatabaseIdentity | null {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return null;

  // A `host` query parameter is how a URL-form DSN names a unix socket
  // directory, and libpq — so also `pg` — lets it override the host in the
  // authority. Reading the hostname and ignoring this would file the run
  // against a server the scan was never connected to.
  const socket = url.searchParams.get('host');
  const host = socket !== null && socket !== '' ? socket : url.hostname;
  if (host === '') return null;

  const port = url.port === '' ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port <= 0) return null;

  return { host, port, database };
}

/**
 * Loads the history store, or fails in a way the caller can report.
 *
 * Imported here instead of at the top of the file for two reasons. It uses
 * `node:sqlite`, which does not exist before Node 22.12 — a static import
 * would turn "no scan history" into "no scan" on a Node this repository still
 * claims to support. And `node:sqlite` announces that it is experimental the
 * moment it loads, which is true, worth knowing once, and not worth stapling
 * across the top of somebody's report. Exactly that one warning is dropped,
 * only while the module loads; the original emitter goes straight back.
 */
async function openStore(file: string): Promise<OpenedHistory> {
  mkdirSync(dirname(file), { recursive: true });

  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]): void => {
    const text = warning instanceof Error ? warning.message : String(warning);
    const name =
      warning instanceof Error
        ? warning.name
        : rest.find((r) => typeof r === 'string');
    if (name === 'ExperimentalWarning' && /sqlite/i.test(text)) return;
    (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;

  try {
    // `openHistory`, not `ScanStore.open`. The difference is what happens to a
    // file written by an older schema: `ScanStore.open` refuses it and leaves
    // the user holding a path they have never heard of, which is how the
    // default history path came to be dead on the machine that shipped the
    // version bump. This moves the old file aside, keeps it, and hands back
    // the receipt so `lines()` can say where it went.
    const { openHistory } = await import('@ledar/store');
    return openHistory(file);
  } finally {
    process.emitWarning = emitWarning;
  }
}

/**
 * The scan's own record of itself, which is never allowed to break the scan.
 *
 * Writing history is secondary work: a database the scan could read is a
 * report the user should get, whether or not a local file could be opened.
 * Every call here swallows its failure — and then says so out loud in the
 * report, because a history that silently stopped being written is how a diff
 * six months from now comes to compare against a run that does not exist.
 */
class RunHistory {
  private store: ScanStore | null = null;
  private file = '';
  /** The run currently open. Cleared once it is closed, or once it breaks. */
  private runId: number | null = null;
  /** The run's number, kept after it closes so the report can name it. */
  private recorded: number | null = null;
  private problem: string | null = null;
  /**
   * A history file this build could not read, moved aside so this one could
   * start. Reported whether or not anything else about the run went well: a
   * file that moves without being mentioned is its own kind of data loss.
   */
  private retired: RetiredHistory | null = null;

  static async open(dsn: string, scope: ScopeManifest): Promise<RunHistory> {
    const history = new RunHistory();

    const identity = identityFrom(dsn, scope.database);
    if (identity === null) {
      history.problem =
        'the connection string is not in postgresql://host:port/name form, so ' +
        'there is no way to say which server this database is on without ' +
        'guessing at it';
      return history;
    }

    history.file = historyFile();
    try {
      const opened = await openStore(history.file);
      history.store = opened.store;
      history.retired = opened.retired;
      history.runId = history.store.openRun({
        database: identity,
        scope,
        // Rule 6: no real data leaves the user's machine, and a sample row
        // written to a file people attach to bug reports has already left.
        // The store defaults this off; it is passed anyway so the choice is
        // visible at the call site rather than inherited from somewhere else.
        storeSamples: false,
      });
      history.recorded = history.runId;
    } catch (err) {
      // The file is named because the failure is usually about the file, and
      // sqlite's own wording ("unable to open database file") does not say
      // which one it could not open.
      history.problem = `${why(err)} (${history.file})`;
      history.stop();
    }

    return history;
  }

  private stop(): void {
    try {
      this.store?.close();
    } catch {
      // Already broken. The first failure is the one worth reporting.
    }
    this.store = null;
    this.runId = null;
  }

  private guard(body: (store: ScanStore, runId: number) => void): void {
    if (this.store === null || this.runId === null) return;
    try {
      body(this.store, this.runId);
    } catch (err) {
      this.problem = why(err);
      this.stop();
    }
  }

  add(findings: readonly Finding[]): void {
    this.guard((store, runId) => store.recordFindings(runId, findings));
  }

  /**
   * What each rule covered, including the rules that found nothing.
   *
   * `add` already records that a rule ran when it produced a finding. This is
   * for the other case, which is the one that matters: a rule that returned
   * nothing and a rule that never got to run leave the same empty space, and
   * only one of them means the database is clean.
   */
  cover(rules: readonly RuleRun[]): void {
    this.guard((store, runId) => store.recordRules(runId, rules));
  }

  complete(cost: BudgetSpend, truncationNote: string | null): void {
    this.guard((store, runId) => {
      store.finishRun(runId, { outcome: 'completed', cost, truncationNote });
      this.stop();
    });
  }

  /**
   * Closes the run as failed, so it is not read later as a clean scan.
   *
   * The cost is what had been spent by the time it broke, not zero. A run
   * that cost the database two hundred queries before it fell over is worth
   * seeing as exactly that.
   */
  failed(err: unknown, cost: BudgetSpend): void {
    this.guard((store, runId) => {
      store.finishRun(runId, {
        outcome: 'failed',
        note: why(err),
        cost,
      });
      this.stop();
    });
  }

  /**
   * What happened to a history file this build could not read.
   *
   * Printed before everything else this class has to say, and printed even
   * when the rest of it went fine, because it is the only notice the user will
   * ever get that a file they own is now somewhere else. The old runs are named
   * as a count rather than described: they are unreadable to this build, and
   * summarising what is in them would be claiming to have read them.
   */
  private retirementLines(): string[] {
    if (this.retired === null) return [];
    const r = this.retired;
    const held =
      r.runs === null
        ? 'its contents could not be counted'
        : `it holds ${r.runs} earlier ${r.runs === 1 ? 'run' : 'runs'}`;

    return [
      `history: the file already at that path was written by schema version ` +
        `${r.version},`,
      `         which this build cannot read. It has been MOVED, not deleted:`,
      `           ${r.to}`,
      `         Nothing in it was changed — ${held}. There is no upgrade path,`,
      `         because the older format has no room for where a claim came`,
      `         from, and inventing that would be worse than starting fresh.`,
      `         Delete it whenever you like. Nothing here will touch it again.`,
    ];
  }

  /** Said in the report either way. Silence would be the one bad answer. */
  lines(): string[] {
    const moved = this.retirementLines();

    if (this.problem === null) {
      return [...moved, `history: recorded as run ${this.recorded} in ${this.file}`];
    }

    if (this.recorded === null) {
      return [
        ...moved,
        `history: this run was NOT recorded — ${this.problem}`,
        `         the report above stands; there is just nothing for the next`,
        `         scan to compare it against`,
      ];
    }

    // A row exists and says `running`, which is what it is. The store keeps
    // that state on purpose so a half-written run is never mistaken for a
    // clean one later.
    return [
      ...moved,
      `history: run ${this.recorded} in ${this.file} was left unfinished —`,
      `         ${this.problem}`,
      `         the report above stands; that run will read as incomplete,`,
      `         because it is`,
    ];
  }
}

// ---- printing --------------------------------------------------------------

function printFact(f: Finding): void {
  // The sentence first, the address second.
  //
  // This read `[high] public.damaged_slug` on the line above the sentence
  // until VS-7. A reader who does not build databases meets that line, files
  // the whole block under "technical, not mine", and the plain sentence
  // underneath inherits the filing — one of the five could say only that
  // there was *"an error involving the votes and the posts"* after reading a
  // report that stated the count, the table and the consequence.
  //
  // Nothing here is dropped. `where` keeps the identifier one indent down,
  // beside the other things a person acts on rather than reads.
  for (const line of wrap(f.plainText, 68)) console.log(`    ${line}`);
  console.log('');
  console.log(`      where: ${f.schema}.${f.table} (severity: ${f.severity})`);
  // Wrapped for the same reason the sentence above is. This half is for the
  // person who will act on it rather than the person deciding whether to,
  // but a 250-character line is no kinder to them.
  for (const line of wrap(`why: ${f.technical}`, 66)) console.log(`      ${line}`);
  if (f.evidence) {
    console.log(
      `      ${f.evidence.rowCount} rows · ${f.evidence.durationMs.toFixed(0)}ms`,
    );
    if (f.coverage.truncatedAt) {
      console.log(`      counting stopped at ${f.coverage.truncatedAt} — there may be more`);
    }
  }
  console.log('');
}

/**
 * What a sampled column is and is not able to say when it comes back clean.
 *
 * Block sampling brought a third kind of zero into a product whose whole
 * purpose is telling kinds of zero apart. *Nothing there* is counted.
 * *Nothing seen* is an empty draw, and it is disclosed. This is *nothing in
 * what I looked at* — and left unsaid it is the most misleading of the three,
 * because it sits inside "nothing stood out" wearing the clothes of a count.
 *
 * The number is the rule of three: see nothing in n independent draws and the
 * rate is, with about 95% confidence, under 3/n. Not a precise instrument
 * here — block samples are not independent draws, so the true bound is looser
 * than this arithmetic implies, which is why the sentence says "roughly" and
 * "at least" rather than quoting a confidence level it has not earned.
 *
 * Built from the SMALLEST draw any column got, because a floor built from an
 * average would describe a look that no individual column received.
 *
 * The measurement behind this, on RubyGems: `gem_downloads.version_id` holds
 * 245 genuinely unmatched rows in 2,196,473 — 0.011%. A ten-thousand-row draw
 * expects one of them and routinely sees none. The rule was right to set that
 * column's sentinel aside. It was not entitled to let the quiet afterwards
 * read as a clean bill.
 */
function printSamplingFloor(sampling: {
  columns: number;
  smallestDraw: number | null;
}): void {
  if (sampling.columns === 0 || sampling.smallestDraw === null) return;

  const floor = (3 / sampling.smallestDraw) * 100;
  const shown = floor < 0.01 ? floor.toFixed(4) : floor.toFixed(2);

  console.log('');
  const floorLine =
    `      ${sampling.columns} of those columns ` +
      `${sampling.columns === 1 ? 'was' : 'were'} too large to ` +
      `read in full, so ${sampling.columns === 1 ? 'it was' : 'they were'} ` +
      `sampled — the smallest sample was ${sampling.smallestDraw.toLocaleString('en-US')} ` +
      `rows. Broken links rarer than roughly ${shown}% of a table can be missed ` +
      `entirely by a sample that size, so silence about ` +
      `${sampling.columns === 1 ? 'it' : 'them'} is not the same as a clean bill.`;
  for (const line of wrap(floorLine.trim(), 66)) console.log(`      ${line}`);
}

/**
 * How much of "checked against real values" had no values in it.
 *
 * The sentence above this one counts a column as checked when a query ran and
 * answered. That is right for the arithmetic and wrong for the reader when the
 * answer was "this table is empty": nothing was compared, and describing it as
 * values that were examined is the report claiming coverage it does not have.
 *
 * Found on MusicBrainz, and it is the clearest case anyone is likely to get.
 * 374 tables, 344 million rows, and all seven of Layer B's candidates sit on
 * derived tables the public dump ships empty. The report said it had checked
 * seven columns against real values three lines under a header saying 164
 * tables held no rows. Both sentences were generated by the same run.
 *
 * Silent when the number is zero, and silent when EVERY column had rows —
 * a line that fires on every scan stops being read.
 */
function printEmptyColumns(checked: number, empty: number): void {
  if (empty === 0) return;

  console.log('');
  if (empty === checked) {
    const all =
      `All ${checked} of those had no rows to compare — the tables ` +
      `holding them are empty. A query ran against each and came back with ` +
      `nothing, so nothing at all was learned here. An empty table is not a ` +
      `clean one.`;
    for (const line of wrap(all, 66)) console.log(`      ${line}`);
    return;
  }
  const some =
    `${empty} of those ${checked} had no rows to compare — the ` +
    `${empty === 1 ? 'table holding it is' : 'tables holding them are'} empty, ` +
    `so nothing was learned about ${empty === 1 ? 'that one' : 'them'}. An ` +
    `empty table is not a clean one.`;
  for (const line of wrap(some, 66)) console.log(`      ${line}`);
}

/** How many lines of a group are printed before the rest is summarised. */
const SET_ASIDE_LINES_SHOWN = 8;

/**
 * One group of Layer B candidates that produced no finding, under its label.
 *
 * There are two such groups and they are not the same news, which is why they
 * are never printed under one heading. `did not check` sitting above a line
 * that reads "only 0% of values line up" is a heading arguing with its own
 * evidence — that percentage is the result of a check. A reader who notices
 * gets a scanner that contradicts itself; a reader who does not gets the work
 * undercounted and the gap overstated.
 *
 * The heading is passed in rather than derived from the entries, because the
 * caller knows which list it is holding and this function must not go looking
 * for that in the reason text.
 */
function printSetAside(
  heading: string,
  entries: readonly { target: string; reason: string }[],
): void {
  if (entries.length === 0) return;

  console.log(`      ${heading}`);
  for (const e of entries.slice(0, SET_ASIDE_LINES_SHOWN)) {
    console.log(`        ${e.target} — ${e.reason}`);
  }
  if (entries.length > SET_ASIDE_LINES_SHOWN) {
    console.log(`        ... and ${entries.length - SET_ASIDE_LINES_SHOWN} more`);
  }
  console.log('');
}

function printQuestion(f: Finding): void {
  // Sentence first, address second — the same swap as `printFact`, and for
  // the same measured reason. This one mattered more: the Layer B finding is
  // the only thing on the page a reader is being asked to make a decision
  // about, and it was introduced by a bare `public.votes.post_id`.
  //
  // The text is wrapped here rather than left to the terminal. Unwrapped it
  // is a single 352-character line, which every surface re-breaks differently
  // and none of them break into paragraphs. A wall of text is skimmed; a
  // paragraph is read.
  for (const line of wrap(f.plainText, 68)) console.log(`    ${line}`);
  console.log('');
  console.log(`      where: ${f.schema}.${f.table}.${f.columns[0] ?? ''}`);
  for (const line of wrap(`what I measured: ${f.technical}`, 66)) {
    console.log(`      ${line}`);
  }
  console.log('');
  for (const line of semanticQuestionFor(f).split('\n')) {
    console.log(`      ${line}`);
  }
  console.log('');
}

async function main(): Promise<number> {
  const dsn = readDsn();
  const client = await connectReadOnly({ dsn });

  try {
    const verdict = await inspectPrivileges(client, SCHEMAS);
    if (verdict.kind === 'refused') {
      console.error(`\n  REFUSED — ${verdict.reason}\n`);
      return 1;
    }

    const budget = new QueryBudget();
    const scope = await readScope(client, SCHEMAS);
    // Checked before anything is said in its name. A manifest whose two
    // denominators cannot both be true is a scope nobody can rely on, and a
    // report without a scope it can rely on should not be printed at all.
    const manifest = assertScopeManifest(manifestFrom(scope, verdict));

    const history = await RunHistory.open(dsn, manifest);

    const measured = await (async () => {
      const graph = await readSchemaGraph(client, SCHEMAS);
      const empty = await probeEmptyTables(client, graph.tables);
      // Half each. Neither layer gets to starve the other by running first,
      // which is what happens with one shared pot consumed in order.
      const layerA = await runLayerA(client, graph, budget.share(0.5));
      const layerB = await runImplicitForeignKeys(client, graph, budget.share(0.5));

      /**
       * The one line the report is never allowed to be without.
       *
       * Built here, inside the block whose failures are recorded, and before
       * a single line of report has been printed. `buildScopeStrip` refuses
       * rather than rendering a best effort, and a refusal has to stop the
       * whole scan for the same reason `sealFindings` does: this is the
       * sentence that bounds every other sentence below it, so a report that
       * cannot state it is a report nobody may read. Letting it through with
       * the strip left off would produce the exact document VS-4 exists to
       * make impossible — findings with no boundary, and nothing on the page
       * to say the boundary went missing.
       *
       * Both packs' rules, in one list. They count disjoint things — a
       * constraint, an index, a candidate column — so the sum is a number of
       * targets rather than a number of findings.
       */
      // The object as well as the line. `targetsNotChecked` is one of the
      // three gaps the closing verdict has to name, and re-deriving it from
      // the rendered sentence would mean parsing our own prose back out.
      const stripData = buildScopeStrip(manifest, [
        ...layerA.rules,
        ...layerB.rules,
      ]);
      const strip = scopeStripLine(stripData);

      return { graph, empty, layerA, layerB, strip, stripData };
    })().catch((err: unknown) => {
      history.failed(err, budget.spend);
      throw err;
    });

    const { graph, empty, layerA, layerB, strip, stripData } = measured;

    /**
     * `abstained` belongs with the negatives, not with the facts.
     *
     * Hoisted above the printer because the verdict needs it before the header
     * is written, and the header is the first thing printed. Getting this
     * wrong is worse than it looks: `kind !== 'negative'` would have counted
     * an abstention as something raised, and a report saying *"I checked 40
     * things and can conclude nothing"* would then arrive at the verdict
     * written for a report that found something. Debt N8 split the claim kinds
     * so nothing downstream could read an abstention as a result.
     */
    const saysNothingFound = (f: Finding): boolean =>
      f.kind === 'negative' || f.kind === 'abstained';

    /**
     * The report's reading of itself, computed once and printed twice.
     *
     * Twice for the same reason the scope strip is printed twice, and the
     * reason is now measured rather than argued: VS-7, 2026-08-23. A reader
     * given the near-empty report concluded *"most of the database is fine"*
     * from a scan of 36 tables of which 18 held no rows. Everything they had
     * to conclude from pointed that way — five reassuring lines to one caveat,
     * and no conclusion at the end, so they wrote their own.
     */
    const conclusion = reportVerdict({
      raised:
        layerA.findings.filter((f) => !saysNothingFound(f)).length +
        layerB.findings.length,
      tablesTotal: graph.tables.length,
      tablesEmpty: empty.size,
      columnsWithNoRows: layerB.columnsWithNoRows,
      targetsNotChecked: stripData.targetsNotChecked,
    });

    /**
     * What Layer B covered, in the only terms that can be stated honestly.
     *
     * `notExamined` is the list that belongs here, and `ruledOut` is the one
     * that must never arrive here. The pack used to return both in a single
     * `skipped` array, and this line was `skipped: []` for exactly that
     * reason: a target the rule queried and then dismissed as coincidence was
     * *checked*, so filing it as skipped made `checked + skipped` come out
     * larger than `eligible` — a fraction nobody could have arrived at, and
     * one `sealFindings` refuses outright. Now that the two are separate
     * lists, the coverage hole can be reported instead of left blank.
     *
     * The `cause` label each entry carries is the pack's, for grouping the
     * report below. `Coverage` records a target and a reason, so the label is
     * dropped rather than leaked into the stored shape.
     */
    const layerBCoverage: Coverage = {
      checked: layerB.candidatesVerified,
      eligible: layerB.candidatesConsidered,
      skipped: layerB.notExamined.map(({ target, reason }) => ({ target, reason })),
      truncatedAt: null,
    };

    history.add([...layerA.findings, ...layerB.findings]);

    /**
     * Every rule that ran, including the ones that found nothing.
     *
     * Debt N30. Only Layer B's single rule reached the history before this,
     * while Layer A's three sat in `layerA.rules` a few lines above — already
     * built, already used for the scope strip printed on screen, and then
     * dropped on the way to the file. A reader of the report saw all four
     * denominators; a reader of the history saw one.
     *
     * That gap is the diff slice's whole problem in miniature. A rule that
     * ran and found nothing and a rule that never ran leave the same empty
     * space in a findings list, and the only thing that separates them is a
     * coverage row saying the rule ran and what it covered. Without Layer A's
     * three rows, a later diff comparing two runs cannot tell "the orphans
     * are gone" from "nobody looked this time" — and it would report the
     * cheerful one.
     *
     * `layerA.rules` already carries `checked` and `notChecked` per rule;
     * `Coverage` wants `skipped` as a list rather than a count, and Layer A's
     * per-rule skip lists are not exposed on the outcome. So the count is
     * carried in `note` and `skipped` is left empty rather than fabricated:
     * an invented target name in a history file is worse than a number
     * stated in words beside it.
     */
    const layerARuns: RuleRun[] = layerA.rules.map((r) => ({
      rule: r.rule,
      ran: r.ran,
      coverage: {
        checked: r.checked,
        eligible: r.eligible,
        skipped: [],
        truncatedAt: null,
      },
      note:
        r.notChecked > 0
          ? `${r.notChecked} of ${r.eligible} targets were not checked. The ` +
            `report names them; this record keeps the count.`
          : null,
    }));

    history.cover([
      ...layerARuns,
      {
        rule: layerB.findings[0]?.rule ?? LAYER_B_RULE,
        ran: true,
        coverage: layerBCoverage,
        note: layerB.budgetExhausted
          ? 'The budget ceiling stopped this rule before it had checked everything.'
          : null,
      },
    ]);
    history.complete(budget.spend, budget.disclosure());

    const disclosure = disclosureFor(verdict);

    console.log('');
    console.log('  WHAT I WAS ABLE TO LOOK AT');
    console.log('');
    console.log(`    ${scopeCoverageSentence(manifest)}`);
    for (const line of describeScope(scope)) console.log(`    ${line}`);
    console.log(
      `    connected as ${verdict.session.currentUser}, read-only ` +
        `${verdict.kind === 'read_only_enforced' ? 'enforced by the database' : 'NOT enforced'}`,
    );
    if (disclosure) console.log(`    ${disclosure}`);

    if (empty.size === graph.tables.length && graph.tables.length > 0) {
      console.log('');
      console.log('    ⚠  EVERY TABLE HERE IS EMPTY.');
      console.log('');
      console.log('       Nothing below is a statement about your data, because');
      console.log('       there is no data. Only the structure was examined. A');
      console.log('       clean result on an empty database means nothing was');
      console.log('       looked at — not that everything is fine.');
    } else if (conclusion.kind === 'silence_with_gaps') {
      // The one shape where the caveat cannot wait for the end.
      //
      // A report that raises nothing spends the next thirty lines saying so in
      // five reassuring ways, and a reader who skims takes the majority
      // reading. This is the same verdict printed at the bottom, moved above
      // the reassurances for the one case where arriving late means arriving
      // after the reader has already decided. VS-7 measured the cost of it
      // arriving late: 1 of 5.
      //
      // Not printed up here for the other shapes. With a finding on the page
      // there is no false all-clear to head off, and pre-empting a report the
      // reader is about to read correctly only teaches them to skip the top.
      console.log('');
      console.log(`    ⚠  ${conclusion.headline}`);
      console.log('');
      // Numbers here, interpretation only at the bottom. Up here the reader
      // has not read the report yet, so there is nothing for an
      // interpretation to attach to - and the sentence it would repeat is
      // already in Layer B's own boundary line further down.
      for (const line of conclusion.gaps) {
        for (const wrapped of wrap(line, 68)) console.log(`       ${wrapped}`);
        console.log('');
      }
    } else if (empty.size > 0) {
      console.log(
        `    ${empty.size} of ${graph.tables.length} tables hold no rows — ` +
          `data rules could not say anything about those`,
      );
    }
    console.log('');

    // The strip, above the findings.
    //
    // Unconditional, and that is the acceptance criterion rather than a
    // stylistic preference: hiding this line is a bug, not a UI option. No
    // flag reaches here, no branch steps over it, and no shape of result
    // turns it off — which is the whole difference between a disclosure and
    // a setting.
    console.log(`    ${strip}`);
    console.log('');

    // ---- Layer A ---------------------------------------------------------
    //
    // `saysNothingFound` is defined once, above, where the verdict also needs
    // it. It used to be declared here and the reason is worth keeping: sending
    // an abstention through `printFact` would read `evidence` off a claim that
    // has none, and print it under the heading "the counts here are facts".
    // Debt N8 split the two kinds so nothing downstream could read an
    // abstention as a result; this is downstream, and so is the verdict.
    const facts = layerA.findings.filter((f) => !saysNothingFound(f));
    const negatives = layerA.findings.filter(saysNothingFound);

    console.log('  ── WHAT THE DATABASE ITSELF CONFIRMS ─────────────────────');
    console.log('');
    if (facts.length > 0) {
      console.log('    The counts here are facts — a query reproduces every one.');
      console.log('    Whether a fact is a problem is a separate question, and');
      console.log('    not one I can answer for you.');
      console.log('');
    }
    if (facts.length === 0) {
      for (const n of negatives) {
        if (n.kind !== 'negative' && n.kind !== 'abstained') continue;
        for (const line of wrap(n.plainText, 68)) console.log(`    ${line}`);
        console.log('');
        // "but only this far" is the right lead-in for a negative — it caveats
        // a result. An abstention has no result to caveat, so it says what it
        // is instead. The sentence a reader skims has to differ, or the split
        // that debt N8 made in the data never reaches them.
        const lead = n.kind === 'abstained' ? 'and that is all I can say:' : 'but only this far:';
        for (const line of wrap(`${lead} ${n.boundary}`, 66)) {
          console.log(`      ${line}`);
        }
        console.log('');
      }
    } else {
      for (const f of facts) printFact(f);
    }

    // ---- Layer B ---------------------------------------------------------
    console.log('  ── PATTERNS WORTH ASKING ABOUT ───────────────────────────');
    console.log('');
    console.log('    Not problems. Things that look like a rule nobody wrote down.');
    console.log('    I cannot tell a leftover from a decision — only you can.');
    console.log('');

    if (layerB.findings.length === 0) {
      console.log('    Nothing stood out.');
      console.log('');
      const bound =
        `but only this far: looked at ${layerB.candidatesConsidered} ` +
        `column${layerB.candidatesConsidered === 1 ? '' : 's'} whose name suggests ` +
        `it points at another table, and checked ${layerB.candidatesVerified} of ` +
        `them against real values. Columns that are named nothing like a ` +
        `reference were not considered at all.`;
      for (const line of wrap(bound, 66)) console.log(`      ${line}`);
      printEmptyColumns(layerB.candidatesVerified, layerB.columnsWithNoRows);
      printSamplingFloor(layerB.sampling);
      if (layerB.partitionsCovered > 0) {
        console.log('');
        console.log(
          `      ${layerB.partitionsCovered} partitions were covered by querying ` +
            `their parent table, not skipped`,
        );
      }
      console.log('');
    } else {
      for (const f of layerB.findings) printQuestion(f);
      printEmptyColumns(layerB.candidatesVerified, layerB.columnsWithNoRows);
      // Also here, and that is the point of it being a function. A sampled
      // column that came back clean says nothing about itself either way, and
      // it says nothing just as loudly in a report that DID raise other
      // questions — where the reader is even likelier to read the silence
      // around them as coverage.
      printSamplingFloor(layerB.sampling);
    }

    // Printed first, and printed whether or not there is a gap after it. This
    // is the scanner declining to raise something it was entitled to raise,
    // and it is the half of the report a person cannot obtain any other way:
    // a tool that only ever prints what it found gives no way to tell
    // restraint apart from blindness. Hiding it would also be the second
    // half of the same error the heading used to make — understating the
    // work while overstating what was missed.
    printSetAside(
      `checked and ruled out ${layerB.ruledOut.length} ` +
        `(queried, and the values did not back the guess):`,
      layerB.ruledOut,
    );

    // The real coverage hole, and the only one of the two that is a hole.
    //
    // The heading no longer says "no query was run against these", and the
    // correction is not cosmetic. Since Layer B started sampling, one of the
    // ways to end up in this list is a query that ran, cost the database
    // something, and came back with no rows in it — an estimate far above the
    // real size draws a percentage of nothing. A heading asserting that no
    // query ran would be false about that entry, and false in the direction
    // this report is least allowed to be: claiming to know how a number was
    // arrived at. "Nothing was learned" is what all of them have in common,
    // and it is all the heading is entitled to say.
    printSetAside(
      `did not check ${layerB.notExamined.length} (nothing was learned about these):`,
      layerB.notExamined,
    );
    const budgetLine = budget.disclosure();
    if (budgetLine) {
      console.log(`      ${budgetLine}`);
      console.log('');
    }

    // The conclusion, in the place a reader goes looking for one.
    //
    // Printed unconditionally, in every shape of result, for the same reason
    // the strip is: the moment this becomes a thing some reports have and
    // others do not, its absence starts carrying a meaning nobody wrote.
    //
    // Before VS-7 this section did not exist. The report ran out of things to
    // say and stopped, and the reader — who needs a conclusion, because a
    // conclusion is the only part of this they can act on — assembled one out
    // of whatever was nearest. On the near-empty report that was five
    // reassuring headlines, and 1 of 5 readers assembled "most of the database
    // is fine" out of a scan where half the tables held nothing at all.
    //
    // The heading is a question about evidence rather than a verdict word.
    // "SUMMARY" would invite skipping it as a repeat of what is above, and it
    // is not a repeat: nothing above states what may be concluded.
    console.log('  ── WHAT THIS REPORT WILL AND WILL NOT SUPPORT ────────────');
    console.log('');
    for (const line of wrap(conclusion.headline, 68)) console.log(`    ${line}`);
    console.log('');
    for (const line of [...conclusion.gaps, ...conclusion.meaning]) {
      for (const wrapped of wrap(line, 66)) console.log(`      ${wrapped}`);
      console.log('');
    }

    // The strip again, below everything it limits.
    //
    // The same line, printed a second time on purpose. `_doc/05` §7: a
    // disclosure is only worth anything if it travels with the conclusion it
    // limits, and a line printed once at the top is a line two hundred rows
    // of findings have already pushed off the screen. Whoever reads to the
    // end of the report is exactly the person about to remember "nothing
    // wrong" and forget "in the schemas we pointed it at", so the boundary
    // is the last thing they read as well as the first.
    //
    // Directly under the verdict now, rather than floating above the cost
    // line. That is what §7 actually asks for: the boundary travelling with
    // the conclusion it bounds, not merely somewhere on the same page.
    console.log(`    ${strip}`);

    // Debt N7. The line above adds every rule together, so a rule that ran and
    // raised nothing disappears into the total — and on screen that is
    // indistinguishable from a rule that never ran. This says which rules were
    // silent and what they covered while being silent.
    //
    // Below the findings, not above them: it is a footnote on what was just
    // read, and a reader who has not seen the findings yet has nothing to
    // attach it to.
    //
    // Only printed when something WAS raised. With nothing found anywhere the
    // negative and abstained claims have already said it in sentences, and
    // saying the same thing twice in two registers is how a report teaches
    // people to skim.
    const raisedPerRule: Record<string, number> = {};
    for (const f of [...layerA.findings, ...layerB.findings]) {
      if (f.kind === 'negative' || f.kind === 'abstained') continue;
      raisedPerRule[f.rule] = (raisedPerRule[f.rule] ?? 0) + 1;
    }
    if (Object.keys(raisedPerRule).length > 0) {
      const silent = scopeStripByRule([...layerA.rules, ...layerB.rules], raisedPerRule);
      if (silent.length > 0) {
        console.log('');
        console.log('      the rules that raised nothing, and what they covered:');
        for (const line of silent) console.log(`        ${line}`);
      }
    }
    console.log('');

    const sp = budget.spend;
    console.log(
      `      cost to your database: ${sp.queries} queries · ` +
        `${(sp.totalMs / 1000).toFixed(1)}s · ${sp.rowsScanned.toLocaleString('en-US')} rows read`,
    );
    console.log('');
    for (const line of history.lines()) console.log(`      ${line}`);
    console.log('');
    // Printed in full, unprompted. Someone deciding whether to grant access
    // is really deciding whether they can undo it, and an undo they have to
    // go looking for is not much of an undo.
    console.log('      to take this access away, run:');
    console.log('');
    for (const l of scope.revokeSql.split(/\r?\n/)) {
      if (l.trim().startsWith('--') || l.trim() === '') continue;
      console.log(`        ${l}`);
    }
    console.log('');

    return 0;
  } finally {
    await client.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\n  ${err instanceof Error ? err.message : err}\n`);
    process.exit(2);
  },
);

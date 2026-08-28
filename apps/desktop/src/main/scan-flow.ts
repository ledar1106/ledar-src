/**
 * S3 "Look at it and write it down" as one function: scan, judge, record.
 *
 * This is the same sequence `npm run scan` performs (apps/cli/src/scan.ts
 * `main`), reshaped into data a window can render instead of lines a terminal
 * prints. Like `connect-flow.ts` it deliberately knows nothing about Electron,
 * so a test can run the whole scan against the fixture database with no window
 * anywhere — and so that, when the engine process grows a scan route, this
 * file is the code that moves there rather than code welded into a shell.
 *
 * Nothing in here writes. Every statement it issues is a read, the connection
 * is opened by the same `connectReadOnly` the CLI uses, and the privileges are
 * re-interrogated before a single query of the scan runs.
 *
 * ## Not one sentence about the database is written here
 *
 * Every string that reaches the reader through `ScanOutcome` was composed by
 * the backend: `describeScope`, `scopeStripLine`, `reportVerdict`,
 * `finding.plainText` / `.technical` / `.boundary`, `history.lines()`,
 * `QueryBudget.disclosure()`, and three entries in the message catalogue —
 * `scan.cost` and the two boundary lead-ins. This file chooses which of them
 * to pass on and in what order; it never phrases one.
 *
 * Choosing a catalogue KEY is still choosing, and one of those choices carries
 * meaning: which lead-in a boundary arrives under says whether the scan looked
 * and found nothing or could not look. That decision is made by claim kind in
 * `boundarySentence` below, off the finding, never by anything this file
 * observed for itself.
 *
 * That is hard rule 2 and §4.1b together, and the restriction is doing real
 * work rather than decorating. A sentence typed here would be a sentence no
 * gate in `@ledar/contracts` has ever seen: it would carry no coverage, no
 * provenance, and no ceiling on how much it is allowed to assert — and it
 * would sit on screen indistinguishable from the ones that do. The only
 * strings this file composes are about the PRODUCT (a session that is not
 * open, a scan already running), never about the data.
 *
 * ## The DSN
 *
 * It is fetched from `session.ts` by handle, used to open one connection and
 * to identify the run in the history, and never returned, logged, or put in a
 * message. `ScanOutcome` has no field it could travel in.
 */

// Built entries by full path, not package names, exactly as `connect-flow.ts`
// imports the connector and for the same reason: every workspace `main` points
// at src/index.ts because the rest of this repo runs under tsx, and Electron's
// main process is plain Node that needs compiled JavaScript.
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
  PrivilegeVerdict,
  ScopeReport,
} from '@ledar/connector-postgres';
import {
  assertScopeManifest,
  scopeManifestFrom,
  buildScopeStrip,
  num,
  reportVerdict,
  planRank,
  scopeStripLine,
  sealFindings,
  translator,
} from '@ledar/contracts';
import type {
  Coverage,
  Finding,
  Lang,
  ScopeManifest,
} from '@ledar/contracts';
import { LAYER_A_RULE_VERSION, runLayerA } from '@ledar/packs-layer-a';
import {
  IMPLICIT_FK_RULE,
  LAYER_B_RULE_VERSION,
  runImplicitForeignKeys,
} from '@ledar/packs-layer-b';
// 🟥 `RunHistory` lives here as of 2026-08-27. Its own header says why, and
// says the desktop is the reason: the shell must write into the same file the
// CLI writes into, or a later `diffRuns` reads a timeline with a seam in it
// that nothing marks. Imported, never copied.
import { RunHistory, databaseFingerprint, identityFrom, ruleRunsFrom } from '@ledar/store';

import type { ReportFinding, ScanOutcome, SessionHandle } from '../shared/ipc.js';
import { SCHEMAS } from './connect-flow.js';
import { currentPlan, noteObservations } from './profile-flow.js';
import { closeSession, dsnFor } from './session.js';

/**
 * The language this shell speaks.
 *
 * A constant, not `langFromEnv`. The CLI reads the environment because a
 * terminal is where `LEDAR_LANG` is a natural thing to set; a desktop app has
 * no such moment, and inferring a report's language from the machine's locale
 * is the inference VS-7 argued against — the person who reads the record later
 * may not be the person who ran it. When the window grows a language switch it
 * passes the choice down as an argument, which is exactly the signature change
 * `RunHistory.open` was given when it moved into `@ledar/store`.
 */
const LANG: Lang = 'en';
const T = translator(LANG);

/** Longest handle worth looking up. A randomUUID is 36 characters. */
const MAX_HANDLE_LENGTH = 128;

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function saysNothingFound(f: Finding): f is StatesABoundary {
  return f.kind === 'negative' || f.kind === 'abstained';
}

/**
 * The two claim kinds that assert nothing was found, named by extraction.
 *
 * Written as `Extract` rather than as its own object type so it cannot drift:
 * a sixth claim kind added to the union in `findings.ts` either lands in here
 * or does not, and either way this stays a description of that union rather
 * than a second opinion about it.
 *
 * ⚠️ It used to be called "the two kinds that carry a `boundary`", and that
 * name has stopped being true: since N50 every kind carries one. What these
 * two still share is what they SAY — nothing was found — which is what the
 * verdict arithmetic below needs to count, and which is a different question
 * from whether a finding states its limits.
 */
type StatesABoundary = Extract<Finding, { kind: 'negative' } | { kind: 'abstained' }>;

/**
 * One finding, in the shape the window renders.
 *
 * `boundary` is on every finding as of N50, and the field crossing this bridge
 * is no longer nullable either. That removed the last piece of meaning this
 * contract carried in an ABSENCE: there is now no arrangement of these fields
 * in which a claim reaches the window without the limits of the measurement
 * that produced it. The contract's own word for the field — "never cut" — is
 * kept by reading it off the finding and never anywhere else.
 *
 * `kind` goes across as itself (debt N49). It used to stay behind, and the
 * only trace of it on the far side was that same `boundary` being non-null —
 * so anything on the window wanting to know whether a finding was an
 * ACCUSATION had to read the answer out of an absence. That is the habit the
 * CLI prints its coverage figures unconditionally to avoid; this bridge had
 * been quietly relying on it.
 */
function toReportFinding(f: Finding, section: 'confirms' | 'patterns'): ReportFinding {
  return {
    plainText: f.plainText,
    technical: f.technical,
    section,
    kind: f.kind,
    boundary: boundarySentence(f),
  };
}

/**
 * The boundary clause, lead-in included — composed here, chosen by claim kind.
 *
 * 🟥 This used to hand over `f.boundary` bare, and that lost something the
 * data had been carefully built to carry. `apps/cli/src/scan.ts` picks between
 * two lead-ins and says why: *"'but only this far' is the right lead-in for a
 * negative — it caveats a result. An abstention has no result to caveat, so it
 * says what it is instead. The sentence a reader skims has to differ, or the
 * split that debt N8 made in the data never reaches them."* The window was the
 * surface where that split never reached them: both kinds arrived as the same
 * naked sentence, and the renderer's own comment claimed the prefix was
 * already on it.
 *
 * Composed on this side rather than in the renderer for the reason at the top
 * of this file — every sentence about the database is the backend's — and the
 * catalogue entries are the same two the CLI uses, so the two surfaces cannot
 * word it differently.
 *
 * The switch is exhaustive on purpose. A sixth claim kind in `findings.ts`
 * fails to compile here rather than falling into a default that returns null,
 * which would file it, silently, as a claim with nothing to disclose.
 *
 * Exported for one reason: which lead-in goes with which kind is a law, and a
 * law nothing pins is a law that survives exactly until somebody tidies it.
 * Reaching it through a whole scan would mean finding a database that produces
 * an abstention on demand, and the fixture does not have one — so the test
 * would end up pinning nothing while looking like it pinned something.
 */
export function boundarySentence(f: Finding): string {
  switch (f.kind) {
    // An abstention has no result to caveat, so it says what it is instead.
    case 'abstained':
      return T('scan.and-that-is-all', { boundary: f.boundary });
    // Everything else caveats a result — a negative caveats "I found nothing"
    // and a claim caveats the count it just stated. Both are the same act, and
    // "but only this far" is the right lead-in for both.
    //
    // 🟥 These three used to return null and the comment here called that "the
    // honest report of a gap" (debt N50). The gap is closed: every finding
    // carries a boundary now, so the return type lost its `| null` and there
    // is no branch left in which the window shows a claim with no limit
    // beside it.
    case 'negative':
    case 'observation':
    case 'inference':
    case 'recommendation':
      return T('scan.but-only-this-far', { boundary: f.boundary });
  }
}

export async function runScanFlow(handle: unknown): Promise<ScanOutcome> {
  // The handle is renderer input and is treated as such. `ipc.ts` checks it
  // too; this is not the same check twice for the sake of it — this function
  // is meant to survive being moved behind the engine's HTTP boundary, where
  // there is no `ipc.ts` in front of it any more.
  if (typeof handle !== 'string' || handle.length === 0 || handle.length > MAX_HANDLE_LENGTH) {
    return { kind: 'no_session', message: 'This session is not open. Connect again.' };
  }

  const dsn = dsnFor(handle);
  if (dsn === null) {
    // Deliberately the same sentence as the malformed case above. A message
    // that distinguished "closed" from "never existed" would answer, for any
    // string handed to it, whether that string is a live handle — and being
    // unguessable is the whole of a handle's protection.
    return { kind: 'no_session', message: 'This session is not open. Connect again.' };
  }

  let client;
  try {
    client = await connectReadOnly({ dsn });
  } catch (err) {
    // No history line, and the empty array is the honest answer rather than a
    // shrug: no run was ever opened, so there is no recording that failed and
    // nothing for `history.lines()` to say. Every path BELOW this point has a
    // history object and therefore always says something.
    return { kind: 'scan_error', message: why(err), historyLines: [] };
  }

  let history: RunHistory | null = null;
  let budget: QueryBudget | null = null;

  try {
    // Asked again, on a connection that was already proved once.
    //
    // Not belt and braces. The handle was issued because the database refused
    // a write in front of us at connect time, and that was a measurement of a
    // moment — a GRANT between then and now changes the answer without
    // changing anything the window can see. Hard rule 1b says read-only is the
    // database's answer and not this app's claim, and an answer from five
    // minutes ago is this app's claim.
    const verdict = await inspectPrivileges(client, SCHEMAS);
    if (verdict.kind !== 'read_only_enforced') {
      // The premise the handle was issued under is gone, so the handle goes
      // with it. This is the runtime that refuses, not a label saying one
      // should (§4.23): after this returns, the same handle gets `no_session`
      // and the person has to connect again and watch it be proved again.
      closeSession(handle);
      return {
        kind: 'scan_error',
        // The backend's sentence in both branches. `verdict.reason` for a
        // refusal; `disclosureFor` for a role that can still write, which is
        // the sentence that function exists to produce and returns non-null
        // for exactly this verdict.
        message: verdict.kind === 'refused' ? verdict.reason : (disclosureFor(verdict) ?? ''),
        historyLines: [],
      };
    }

    budget = new QueryBudget();
    const scope = await readScope(client, SCHEMAS);
    // Checked before anything is said in its name. A manifest whose two
    // denominators cannot both be true is a scope nobody can rely on, and a
    // report without a scope it can rely on should not be rendered at all.
    const manifest = assertScopeManifest(
      scopeManifestFrom(
        scope,
        verdict.kind === 'read_only_enforced',
        disclosureFor(verdict),
      ),
    );

    history = await RunHistory.open(dsn, manifest, LANG);

    const graph = await readSchemaGraph(client, SCHEMAS);

    /**
     * What the schema itself says about the five areas — ideal §12's audit.
     *
     * Runs here rather than in its own pass because the graph is already read
     * and it costs nothing more: `observeAreas` looks at NAMES only, so this
     * adds no query, touches no row, and cannot slow anyone's database down.
     *
     * ⚠️ It observes and records; it decides nothing. The map is only built
     * when the person's answers arrive (`profile-flow.saveProfile`), because
     * a map assembled from one half would be a claim about somebody's system
     * with nothing on the other side of it to disagree.
     *
     * A fingerprint that cannot be derived means the run cannot be filed
     * against a database either — `RunHistory.open` below says the same thing
     * about itself — so the observations are dropped rather than filed under
     * a guess.
     */
    const identity = identityFrom(dsn, scope.database);
    if (identity !== null) {
      noteObservations(
        databaseFingerprint(identity),
        {
          // `schemasGranted`, not everything the server has. A schema this
          // role cannot enter is one the scan never saw inside, and letting a
          // NAME alone settle an area would be observing something through a
          // door that stayed shut.
          schemas: scope.schemasGranted,
          // 🟥 Partitions dropped. Pagila's `payment` has 54 of them, and
          // without this the window would be told the product saw a payments
          // table 55 times — one sighting per partition, all of them the same
          // table wearing a date. A count that inflates with a storage detail
          // is a count that tells a reader something untrue about their own
          // system.
          tables: graph.tables
            .filter((t) => !t.isPartition)
            .map((t) => ({ schema: t.schema, table: t.table })),
          columns: graph.columns.map((c) => ({
            schema: c.schema,
            table: c.table,
            name: c.name,
          })),
        },
        new Date().toISOString(),
      );
    }

    const empty = await probeEmptyTables(client, graph.tables);
    // Half each. Neither layer gets to starve the other by running first,
    // which is what happens with one shared pot consumed in order.
    const layerA = await runLayerA(client, graph, budget.share(0.5), LANG);
    /**
     * Ideal §25, and the first thing the profile is allowed to change.
     *
     * The plan does not decide WHETHER a column is examined — every candidate
     * the budget reaches is still examined, and every one it does not is set
     * aside by name. It decides the ORDER, which is the answer to *"if the
     * ceiling stops me halfway, which half did I spend it on?"* Before this
     * the answer was whatever order the catalog returned.
     *
     * Null on the first scan of a database nobody has answered questions about
     * yet, and null is passed straight through — `runImplicitForeignKeys`
     * treats it as "the order you already had", so a person who has not been
     * asked anything gets exactly the behaviour that shipped before this.
     */
    const plan = currentPlan();
    const layerB = await runImplicitForeignKeys(
      client,
      graph,
      budget.share(0.5),
      LANG,
      undefined,
      plan === null ? null : (_schema, table) => planRank(plan, table),
    );

    // The line the report is never allowed to be without, built before any of
    // it is assembled. `buildScopeStrip` refuses rather than rendering a best
    // effort, and a refusal has to stop the whole scan: this is the sentence
    // that bounds every other sentence, so a report that cannot state it is a
    // report nobody may read. The object as well as the line —
    // `targetsNotChecked` is one of the gaps the verdict has to name, and
    // re-deriving it from the rendered sentence would mean parsing our own
    // prose back out.
    const stripData = buildScopeStrip(manifest, [...layerA.rules, ...layerB.rules]);
    const scopeStrip = scopeStripLine(stripData, LANG);

    /**
     * The gate, run again at the second door.
     *
     * Both packs already seal what they publish, so in the ordinary case this
     * refuses nothing — which is the point, and it is the same argument
     * `scopeStripLine` makes when it re-runs `assertStripAddsUp` on a strip
     * that was built by `buildScopeStrip` moments earlier. §4.9 ①: a gate
     * bound to a mechanism protects only what travels through that mechanism,
     * and this window is a brand new route from a finding to a reader. The
     * gate belongs at the boundary that hands findings to the renderer, not
     * only at the one that made them.
     *
     * Sealed as two lists rather than one because `section` is not a property
     * of a finding — it is which pack vouched for it — and concatenating first
     * would throw that away. A refusal names which side it came from.
     */
    const confirms = sealFindings(layerA.findings, 'desktop scan-flow (layer A)');
    const patterns = sealFindings(layerB.findings, 'desktop scan-flow (layer B)');

    /**
     * The report's reading of itself.
     *
     * ⚠️ One deliberate difference from apps/cli/src/scan.ts, and it is a
     * design choice rather than a transcription slip. The CLI counts
     * `layerB.findings.length` whole while filtering Layer A through
     * `saysNothingFound`. Both arrive at the same number today, because Layer
     * B says "nothing stood out" in a printer branch instead of publishing a
     * negative claim. But which claim KINDS count as raised is a property of
     * the claim, not of the pack that produced it, and applying the predicate
     * to one list and not the other writes today's Layer B output into this
     * arithmetic as an assumption. The first negative claim Layer B ever
     * publishes would be counted as something raised — the exact reading debt
     * N8 split the kinds to prevent — and it would be counted silently.
     */
    const verdictOfRun = reportVerdict(
      {
        raised:
          confirms.filter((f) => !saysNothingFound(f)).length +
          patterns.filter((f) => !saysNothingFound(f)).length,
        tablesTotal: graph.tables.length,
        tablesEmpty: empty.size,
        columnsWithNoRows: layerB.columnsWithNoRows,
        targetsNotChecked: stripData.targetsNotChecked,
      },
      LANG,
    );

    history.add([...layerA.findings, ...layerB.findings]);

    /**
     * Every rule that ran, including the ones that found nothing.
     *
     * Debt N30. A rule that ran and found nothing and a rule that never ran
     * leave the same empty space in a findings list, and a coverage row is the
     * only thing that separates them. Without them a later diff cannot tell
     * "the orphans are gone" from "nobody looked this time", and it would
     * report the cheerful one.
     *
     * `skipped` is left empty for Layer A and the count carried in `note`,
     * because the pack does not expose per-rule skip lists on its outcome —
     * an invented target name in a history file is worse than a number stated
     * in words beside it. `ruleVersion` is taken from each pack's exported
     * constant, never typed here: a literal goes stale on the first bump, and
     * a history claiming a version the rule was not running is worse than one
     * claiming none.
     */
    const layerARuns = ruleRunsFrom(
      layerA.rules.map((r) => ({
        rule: r.rule,
        ran: r.ran,
        coverage: {
          checked: r.checked,
          eligible: r.eligible,
          skipped: [],
          // Layer A never samples: it counts every offending row up to a
          // ceiling, and a ceiling is `truncatedAt`, not a sample.
          visibleToRole: null,
          verified: r.checked,
          sampled: 0,
          excluded: 0,
          truncatedAt: null,
        },
        note:
          r.notChecked > 0
            ? `${r.notChecked} of ${r.eligible} targets were not checked. The ` +
              `report names them; this record keeps the count.`
            : null,
      })),
      LAYER_A_RULE_VERSION,
    );

    /**
     * What Layer B covered, in the only terms that can be stated honestly.
     *
     * `notExamined` belongs here and `ruledOut` must not: a target the rule
     * queried and then dismissed as coincidence was CHECKED, and filing it as
     * skipped makes `checked + skipped` come out larger than `eligible` — a
     * fraction nobody could have arrived at, and one `sealFindings` refuses.
     *
     * `visibleToRole` is null rather than a count of every column in every
     * readable table: `candidatesConsidered` is already this rule's
     * eligibility test, and a role-visibility total here would answer a
     * question nobody asked with a number that looks like coverage.
     */
    const layerBCoverage: Coverage = {
      checked: layerB.candidatesVerified,
      eligible: layerB.candidatesConsidered,
      skipped: layerB.notExamined.map(({ target, reason }) => ({ target, reason })),
      truncatedAt: null,
      visibleToRole: null,
      sampled: layerB.sampling.columns,
      verified: layerB.candidatesVerified - layerB.sampling.columns,
      // Looked at, then set aside because the values did not back the guess.
      // Not `skipped`: those were never examined, and the two lead a reader to
      // opposite conclusions about whether to go and look themselves.
      excluded: layerB.ruledOut.length,
    };

    history.cover([
      ...layerARuns,
      {
        // The pack's own constant when there is no finding to read the id off.
        // A copied string here would go stale on the first rename and grow a
        // rule in the history that never ran.
        rule: layerB.findings[0]?.rule ?? IMPLICIT_FK_RULE,
        ran: true,
        ruleVersion: LAYER_B_RULE_VERSION,
        coverage: layerBCoverage,
        note: layerB.budgetExhausted
          ? 'The budget ceiling stopped this rule before it had checked everything.'
          : null,
      },
    ]);
    // Read ONCE, into a name, and handed to both the record and the reader.
    // Calling `budget.disclosure()` twice would work today and is exactly the
    // shape that stops working the day it composes anything from a counter —
    // and the failure would be the file saying one thing and the screen
    // another about the same scan, which is the seam N51 was filed under.
    const cut = budget.disclosure();
    history.complete(budget.spend, cut);

    const spent = budget.spend;

    return {
      kind: 'scanned',
      scopeStrip,
      scopeLines: describeScope(scope, T),
      verdict: verdictOfRun,
      findings: [
        ...confirms.map((f) => toReportFinding(f, 'confirms')),
        ...patterns.map((f) => toReportFinding(f, 'patterns')),
      ],
      // Composed by the catalogue, not here. `num` so the counts are grouped
      // the way the run's language groups them.
      costLine: T('scan.cost', {
        queries: num(spent.queries, LANG),
        seconds: (spent.totalMs / 1000).toFixed(1),
        rows: num(spent.rowsScanned, LANG),
      }),
      // The budget's own words, not a summary of them. N51.
      disclosure: cut,
      historyLines: history.lines(),
      revokeSql: scope.revokeSql,
    };
  } catch (err) {
    // Closed as failed so it is never read later as a clean scan. `history`
    // is null only for a throw before it was opened, and `budget` is opened
    // strictly before `history`, so a history that exists always has a spend
    // to record — the compiler cannot see that, hence both checks.
    if (history !== null && budget !== null) {
      history.failed(err, budget.spend);
    }
    return {
      kind: 'scan_error',
      message: why(err),
      // Said even here, and especially here. A scan that broke halfway is
      // exactly the run whose reader needs to know whether anything was
      // written down, and `RunHistory` is built to answer that out loud rather
      // than fail quietly.
      historyLines: history?.lines() ?? [],
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

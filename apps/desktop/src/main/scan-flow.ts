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
 * `finding.plainText` / `.technical` / `.boundary`, `history.lines()`, and the
 * `scan.cost` entry in the message catalogue. This file chooses which of them
 * to pass on and in what order; it never phrases one.
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
  buildScopeStrip,
  num,
  reportVerdict,
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
import { RunHistory } from '@ledar/store';
import type { RuleRun } from '@ledar/store';

import type { ReportFinding, ScanOutcome, SessionHandle } from '../shared/ipc.js';
import { SCHEMAS } from './connect-flow.js';
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

/**
 * The connector's scope report, in the shape the contracts package validates.
 *
 * ⚠️ A second copy of `manifestFrom` in apps/cli/src/scan.ts. It is duplicated
 * rather than imported because apps/cli is not a dependency of this app and
 * the function lives in neither package — REPORTED upward rather than fixed
 * here, since moving it is a change to files this slice does not own.
 *
 * The one line that needed a decision is `totalTables`, and the CLI's reason
 * is repeated here because a copy that keeps the code and drops the reason is
 * a copy that gets "simplified" back into the bug. Handing it
 * `tablesInRequestedSchemas` compiles, reads naturally, and is a lie: that
 * number counts tables in the schemas the scan was pointed at, so on a
 * Supabase project it renders as "35 of 35 tables — all of them" about a
 * database holding 76. Numerator: coverage. Denominator: existence. Neither is
 * inferred from the other.
 *
 * `schemas` is the GRANTED list, not the requested one — a schema that was
 * asked for and refused was not in scope no matter what was asked.
 */
function manifestFrom(scope: ScopeReport, verdict: PrivilegeVerdict): ScopeManifest {
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

/**
 * A claim that reports having found nothing, rather than something.
 *
 * Hoisted so the verdict's arithmetic and the report's sections read the same
 * list the same way. Debt N8 split the claim kinds precisely so that nothing
 * downstream could read an abstention as a result: `kind !== 'negative'` alone
 * would count "I checked 40 things and can conclude nothing" as something
 * raised, and hand that report the verdict written for a report that found
 * something.
 */
function saysNothingFound(f: Finding): f is StatesABoundary {
  return f.kind === 'negative' || f.kind === 'abstained';
}

/**
 * The two claim kinds that carry a `boundary`, named by extraction.
 *
 * Written as `Extract` rather than as its own object type so it cannot drift:
 * a sixth claim kind added to the union in `findings.ts` either lands in here
 * or does not, and either way this stays a description of that union rather
 * than a second opinion about it. The type predicate above is what lets the
 * compiler agree that a finding filed under one of these has a boundary to
 * read — without it, reading `.boundary` is a claim the type system has no
 * reason to accept, and reading it off the other three kinds would be
 * reaching for a field that is not there.
 */
type StatesABoundary = Extract<Finding, { kind: 'negative' } | { kind: 'abstained' }>;

/**
 * One finding, in the shape the window renders.
 *
 * `boundary` exists on the `negative` and `abstained` members of `Finding` and
 * on no others, which is why the contract types it `string | null` rather than
 * optional: null here means this kind of claim has no boundary to state, not
 * that a boundary was dropped on the way out. The contract's own comment on
 * the field — "never cut" — is about the second case, and the only way to keep
 * that promise is to read the field off the finding and never anywhere else.
 */
function toReportFinding(f: Finding, section: 'confirms' | 'patterns'): ReportFinding {
  return {
    plainText: f.plainText,
    technical: f.technical,
    section,
    boundary: saysNothingFound(f) ? f.boundary : null,
  };
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
    const manifest = assertScopeManifest(manifestFrom(scope, verdict));

    history = await RunHistory.open(dsn, manifest, LANG);

    const graph = await readSchemaGraph(client, SCHEMAS);
    const empty = await probeEmptyTables(client, graph.tables);
    // Half each. Neither layer gets to starve the other by running first,
    // which is what happens with one shared pot consumed in order.
    const layerA = await runLayerA(client, graph, budget.share(0.5), LANG);
    const layerB = await runImplicitForeignKeys(client, graph, budget.share(0.5), LANG);

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
    const layerARuns: RuleRun[] = layerA.rules.map((r) => ({
      rule: r.rule,
      ran: r.ran,
      ruleVersion: LAYER_A_RULE_VERSION,
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
    }));

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
    history.complete(budget.spend, budget.disclosure());

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

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
  scopeManifestFrom,
  buildScopeStrip,
  buildUserRuleSection,
  scopeStripByRule,
  scopeCoverageSentence,
  scopeStripLine,
  reportVerdict,
  emptyTablesLine,
  langFromEnv,
  num,
  translator,
} from '@ledar/contracts';
import type { Coverage, Finding, ScopeManifest } from '@ledar/contracts';
import { LAYER_A_RULE_VERSION, runLayerA } from '@ledar/packs-layer-a';
import {
  IMPLICIT_FK_RULE,
  LAYER_B_RULE_VERSION,
  runImplicitForeignKeys,
  semanticQuestionFor,
} from '@ledar/packs-layer-b';
import { RunHistory, ruleRunsFrom } from '@ledar/store';

import { ledarDir } from './paths.js';
import { wrap } from './text.js';

/**
 * The language this run speaks, decided once.
 *
 * VS-7 measured why: five readers, none of whom could read the English the
 * report was written in, so it had to be translated by hand before the gate
 * could run. English stays the default — a report is evidence about someone's
 * database, and the person reading it later may not be the person who ran it,
 * so choosing is explicit rather than inferred from a machine's locale.
 */
const LANG = langFromEnv(process.env);
const T = translator(LANG);

/**
 * A section rule, padded to one width whatever language filled it.
 *
 * Hard-coded dashes were fine while every heading was English and its length
 * was known when it was typed. `NHUNG CHO DANG HOI LAI` is not the width of
 * `PATTERNS WORTH ASKING ABOUT`, and a rule that stops mid-line reads as a
 * rendering fault rather than a heading.
 */
const HEAD_WIDTH = 58;
function heading(text: string): string {
  const prefix = `  ── ${text} `;
  return prefix + '─'.repeat(Math.max(3, HEAD_WIDTH - prefix.length));
}

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
  console.log(
    `      ${T('scan.where-with-severity', {
      target: `${f.schema}.${f.table}`,
      severity: f.severity,
    })}`,
  );
  // Wrapped for the same reason the sentence above is. This half is for the
  // person who will act on it rather than the person deciding whether to,
  // but a 250-character line is no kinder to them.
  for (const line of wrap(T('scan.why', { detail: f.technical }), 66)) {
    console.log(`      ${line}`);
  }
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
  const floorLine = T('scan.sampling-floor', {
    columns: sampling.columns,
    smallest: num(sampling.smallestDraw, LANG),
    floor: shown,
  });
  for (const line of wrap(floorLine, 66)) console.log(`      ${line}`);
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
    const all = T('scan.empty-columns.all', { checked });
    for (const line of wrap(all, 66)) console.log(`      ${line}`);
    return;
  }
  const some = T('scan.empty-columns.some', { empty, checked });
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
  console.log(
    `      ${T('scan.where', { target: `${f.schema}.${f.table}.${f.columns[0] ?? ''}` })}`,
  );
  for (const line of wrap(T('scan.what-i-measured', { detail: f.technical }), 66)) {
    console.log(`      ${line}`);
  }
  console.log('');
  for (const line of semanticQuestionFor(f, LANG).split('\n')) {
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
    const manifest = assertScopeManifest(
      scopeManifestFrom(
        scope,
        verdict.kind === 'read_only_enforced',
        disclosureFor(verdict),
      ),
    );

    const history = await RunHistory.open(dsn, manifest);

    const measured = await (async () => {
      const graph = await readSchemaGraph(client, SCHEMAS);
      const empty = await probeEmptyTables(client, graph.tables);
      // Half each. Neither layer gets to starve the other by running first,
      // which is what happens with one shared pot consumed in order.
      const layerA = await runLayerA(client, graph, budget.share(0.5), LANG);
      const layerB = await runImplicitForeignKeys(client, graph, budget.share(0.5), LANG);

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
      const strip = scopeStripLine(stripData, LANG);

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
    }, LANG);

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
      // null: `candidatesConsidered` is already the count of columns whose
      // NAME suggests a reference, which is this rule's eligibility test, not
      // what the role can see. Every other column in every readable table is
      // visible and was never a target, and putting that total here would
      // answer a question nobody asked with a number that looks like coverage.
      visibleToRole: null,
      // Of the columns checked, the ones too large to read end to end. The
      // sentence about this already existed in the report — "broken links
      // rarer than roughly 0.03% of a table can be missed entirely" — and the
      // number behind it was nowhere in the record until now.
      sampled: layerB.sampling.columns,
      verified: layerB.candidatesVerified - layerB.sampling.columns,
      // Looked at, then set aside because the values did not back the guess.
      // Not `skipped`: those were never examined, and the two lead a reader to
      // opposite conclusions about whether to go and look themselves.
      excluded: layerB.ruledOut.length,
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
    // Debt N40. The version is threaded in by `ruleRunsFrom` from the pack's
    // own exported constant, never typed here: a literal would go stale on the
    // first bump, and a history claiming a version the rule was not running is
    // worse than one claiming none.
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

    history.cover([
      ...layerARuns,
      {
        rule: layerB.findings[0]?.rule ?? LAYER_B_RULE,
        ran: true,
        ruleVersion: LAYER_B_RULE_VERSION,
        coverage: layerBCoverage,
        note: layerB.budgetExhausted
          ? 'The budget ceiling stopped this rule before it had checked everything.'
          : null,
      },
    ]);
    history.complete(budget.spend, budget.disclosure());

    const disclosure = disclosureFor(verdict);

    console.log('');
    console.log(`  ${T('head.looked-at')}`);
    console.log('');
    for (const line of wrap(scopeCoverageSentence(manifest, LANG), 68)) {
      console.log(`    ${line}`);
    }
    for (const line of describeScope(scope, T)) {
      for (const wrapped of wrap(line, 68)) console.log(`    ${wrapped}`);
    }
    console.log(
      `    ${T('scan.connected-as', {
        user: verdict.session.currentUser,
        enforcement: T(
          verdict.kind === 'read_only_enforced'
            ? 'scan.read-only-enforced'
            : 'scan.read-only-not-enforced',
        ),
      })}`,
    );
    if (disclosure) console.log(`    ${disclosure}`);

    if (empty.size === graph.tables.length && graph.tables.length > 0) {
      console.log('');
      console.log(`    ⚠  ${T('scan.every-table-empty')}`);
      console.log('');
      for (const line of wrap(T('scan.every-table-empty.body'), 68)) {
        console.log(`       ${line}`);
      }
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
      // Through the same function as the verdict's own gap line, not a second
      // copy of the same decision. The two print one fact in two places, and a
      // reader who meets it once as "half of them" and once as "18 of 36" has
      // been shown two facts and given no way to tell which to believe.
      const line = emptyTablesLine(
        { plain: 'scan.tables-empty-line', withShare: 'scan.tables-empty-line.share' },
        empty.size,
        graph.tables.length,
        LANG,
      );
      for (const wrapped of wrap(line, 68)) {
        console.log(`    ${wrapped}`);
      }
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

    console.log(heading(T('head.database-confirms')));
    console.log('');
    if (facts.length > 0) {
      for (const line of wrap(T('scan.facts-are-facts'), 68)) {
        console.log(`    ${line}`);
      }
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
        const lead = n.kind === 'abstained' ? 'scan.and-that-is-all' : 'scan.but-only-this-far';
        for (const line of wrap(T(lead, { boundary: n.boundary }), 66)) {
          console.log(`      ${line}`);
        }
        console.log('');
      }
    } else {
      for (const f of facts) printFact(f);
    }

    // ---- Rules the USER asked for ----------------------------------------
    //
    // Conditional, and that is the whole reason this can exist at all. VS-7
    // measured this layout with five real readers and there is no second
    // round, so a change to it can never be re-measured. Nothing produces a
    // user rule yet — VS-6 has no screens and nothing here calls `runRule` —
    // so `buildUserRuleSection` returns null on every report anyone has read,
    // and the measured layout stays byte-identical.
    //
    // Placed after the database and before the patterns. Two orderings agree,
    // which is how you know it is not taste: by authority (the database
    // declared it > you declared it > I guessed it) and by confidence
    // (certain > probable > unconfirmed).
    const asked = buildUserRuleSection(
      [...layerA.findings, ...layerB.findings],
      LANG,
    );
    if (asked) {
      console.log(heading(asked.heading));
      console.log('');
      for (const line of wrap(asked.preamble, 68)) console.log(`    ${line}`);
      console.log('');
      for (const e of asked.entries) {
        for (const line of wrap(e.plain, 68)) console.log(`    ${line}`);
        console.log('');
        console.log(`      ${T('scan.where', { target: e.where })}`);
        for (const line of wrap(T('scan.why', { detail: e.why }), 66)) {
          console.log(`      ${line}`);
        }
        if (e.boundary !== null) {
          for (const line of wrap(T('scan.but-only-this-far', { boundary: e.boundary }), 66)) {
            console.log(`      ${line}`);
          }
        }
        console.log('');
      }
    }

    // ---- Layer B ---------------------------------------------------------
    console.log(heading(T('head.patterns')));
    console.log('');
    for (const line of wrap(T('scan.patterns-preamble'), 68)) {
      console.log(`    ${line}`);
    }
    console.log('');

    if (layerB.findings.length === 0) {
      console.log(`    ${T('scan.nothing-stood-out')}`);
      console.log('');
      const bound = T('scan.layer-b-boundary', {
        considered: layerB.candidatesConsidered,
        verified: layerB.candidatesVerified,
      });
      for (const line of wrap(bound, 66)) console.log(`      ${line}`);
      printEmptyColumns(layerB.candidatesVerified, layerB.columnsWithNoRows);
      printSamplingFloor(layerB.sampling);
      if (layerB.partitionsCovered > 0) {
        console.log('');
        for (const line of wrap(
          T('scan.partitions-covered', { count: layerB.partitionsCovered }),
          66,
        )) {
          console.log(`      ${line}`);
        }
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
      T('scan.ruled-out', { count: layerB.ruledOut.length }),
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
      T('scan.did-not-check', { count: layerB.notExamined.length }),
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
    console.log(heading(T('head.verdict')));
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
      const silent = scopeStripByRule(
        [...layerA.rules, ...layerB.rules],
        raisedPerRule,
        LANG,
      );
      if (silent.length > 0) {
        console.log('');
        console.log(`      ${T('scan.silent-rules')}`);
        for (const line of silent) console.log(`        ${line}`);
      }
    }
    console.log('');

    const sp = budget.spend;
    console.log(
      `      ${T('scan.cost', {
        queries: num(sp.queries, LANG),
        seconds: (sp.totalMs / 1000).toFixed(1),
        rows: num(sp.rowsScanned, LANG),
      })}`,
    );
    console.log('');
    // Split on newlines the message put there; NOT wrapped.
    //
    // The recorded case is a label followed by a filesystem path, and wrapping
    // broke the path onto its own line — which reads as two facts, and which
    // four tests that extract the run number from this line stopped matching.
    // Messages that need more than one line carry their own breaks, the way
    // this code did before the catalogue.
    for (const line of history.lines()) {
      for (const piece of line.split('\n')) console.log(`      ${piece}`);
    }
    console.log('');
    // Printed in full, unprompted. Someone deciding whether to grant access
    // is really deciding whether they can undo it, and an undo they have to
    // go looking for is not much of an undo.
    console.log(`      ${T('scan.revoke')}`);
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

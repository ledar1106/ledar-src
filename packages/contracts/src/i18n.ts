/**
 * Every sentence this product says, in one place, in each language it says it.
 *
 * VS-7 measured why this exists. Five people read the report; none of them
 * could read English, so it had to be translated by hand before the gate could
 * run at all. That is a fact about the users, not an inconvenience in the
 * measurement — the product's only output does not reach the person it is for.
 *
 * ## Why the store did not have to change
 *
 * The obvious fear is that localising text breaks the diff: run one in
 * English, run two in Vietnamese, every finding reported as changed. It does
 * not, and the reason was designed in before this file existed. `structureHash`
 * hashes rule, kind, confidence, severity, origin, confidenceBasis, schema,
 * table and columns — *"a hash of WHAT THE CLAIM SAYS, not who said it"* — and
 * `diffRuns` matches on that plus `findingKey`. No prose is compared anywhere
 * in identity. A history may hold both languages and the diff across the seam
 * is silent, correctly.
 *
 * What the history does NOT record is which language a run was rendered in.
 * Nothing is wrong today because nothing reads the prose to decide anything,
 * but a mixed-language history cannot be explained by looking at it. That is
 * debt N44, not a defect, and it is written down rather than left to be
 * discovered.
 *
 * ## Why the catalogue is functions and not template strings
 *
 * `"{n} of {total} tables"` works until a language needs the count to change
 * the noun, or needs a different clause order, or — Vietnamese — needs no
 * plural inflection at all where English needs one. A function per message
 * lets each language solve its own grammar instead of forcing every language
 * through English's.
 *
 * ## Why a missing translation cannot ship
 *
 * `Catalog` is `Record<MessageKey, …>` over a closed union, so a language file
 * missing a key does not compile. The alternative — falling back to English at
 * runtime — produces a report that is Vietnamese except for the three
 * sentences nobody remembered, which is worse than an English report because
 * the reader stops trusting the parts they can read.
 */

import { EN } from './messages/en.js';
import { VI } from './messages/vi.js';

/** Languages this product can speak. Adding one is adding a file. */
export const LANGS = ['en', 'vi'] as const;
export type Lang = (typeof LANGS)[number];

export function isLang(value: string): value is Lang {
  return (LANGS as readonly string[]).includes(value);
}

/**
 * The language to render in, from the environment.
 *
 * English is the default, and stays the default even for a Vietnamese
 * operator, because a report is evidence about someone's database and the
 * person who has to read it later may not be the person who ran it. Choosing
 * is explicit.
 */
export function langFromEnv(env: Record<string, string | undefined>): Lang {
  const named = env['LEDAR_LANG']?.trim().toLowerCase();
  return named !== undefined && isLang(named) ? named : 'en';
}

export type Params = Record<string, string | number>;

/**
 * Every message key in the product.
 *
 * Grouped by where the sentence appears, and named for what it says rather
 * than where it is printed — a key called `report.line14` survives exactly one
 * edit.
 */
export type MessageKey =
  // ---- report headings ----
  | 'head.looked-at'
  | 'head.database-confirms'
  | 'head.patterns'
  | 'head.verdict'
  // ---- the scan's own voice ----
  | 'scan.connected-as'
  | 'scan.read-only-enforced'
  | 'scan.read-only-not-enforced'
  | 'scan.every-table-empty'
  | 'scan.every-table-empty.body'
  | 'scan.tables-empty-line'
  | 'scan.tables-empty-line.share'
  | 'scan.facts-are-facts'
  | 'scan.patterns-preamble'
  | 'scan.nothing-stood-out'
  | 'scan.where'
  | 'scan.where-with-severity'
  | 'scan.why'
  | 'scan.what-i-measured'
  | 'scan.but-only-this-far'
  | 'scan.and-that-is-all'
  | 'scan.layer-b-boundary'
  | 'scan.empty-columns.all'
  | 'scan.empty-columns.some'
  | 'scan.sampling-floor'
  | 'scan.partitions-covered'
  | 'scan.ruled-out'
  | 'scan.did-not-check'
  | 'scan.silent-rules'
  | 'scan.cost'
  | 'scan.revoke'
  | 'history.recorded'
  | 'history.not-recorded'
  | 'history.unfinished'
  | 'history.moved'
  | 'history.holds-runs'
  | 'history.holds-nothing'
  | 'history.holds-uncounted'
  | 'history.delete-freely'
  // ---- the verdict ----
  | 'verdict.nothing-seen'
  | 'verdict.nothing-seen.all-empty'
  | 'verdict.nothing-seen.meaning'
  | 'verdict.silence-with-gaps'
  | 'verdict.silence-with-gaps.meaning'
  | 'verdict.silence-is-clean'
  | 'verdict.silence-is-clean.meaning'
  | 'verdict.raised'
  | 'verdict.raised.meaning'
  | 'verdict.gap.empty-tables'
  | 'verdict.gap.empty-tables.share'
  | 'verdict.gap.empty-columns'
  | 'verdict.gap.not-checked'
  // ---- how big a count is against its whole ----
  //
  // Quantities, not sentences. They are interpolated into the two lines that
  // report empty tables, so that a reader is told the magnitude instead of
  // being handed the division that produces it. See share.ts.
  | 'share.quarter'
  | 'share.third'
  | 'share.half'
  | 'share.two-thirds'
  | 'share.three-quarters'
  | 'share.almost-all'
  | 'share.all'
  // ---- what the model step did not add ----
  //
  // HS-D D.5. Both name what is MISSING and neither grades what is present;
  // `assertDoesNotDisparage` in model-step.ts is run over both by its test.
  | 'model.unavailable'
  | 'model.declined'
  | 'model.addition-heading'
  // ---- a bounded answer, rendered by the product ----
  //
  // The model returns identifiers; these are the sentences. Adding a market
  // is adding these keys to one more catalogue, which `Catalog` refuses to
  // compile without — rather than adding a banned-word list in a language
  // nobody on the team reads. See bounded-answer.ts.
  | 'answer.rests-on'
  | 'answer.cannot'
  | 'answer.missing.who'
  | 'answer.missing.when'
  | 'answer.missing.why'
  | 'answer.missing.which_rows'
  | 'answer.missing.impact'
  | 'answer.missing.elsewhere'
  // ---- a bounded RULE, read back before it runs ----
  //
  // VS-6. The model picked a check and a target; these are the words. This is
  // the only control standing in the one door `sealRule` cannot close — a
  // well-formed check pointed at the wrong table — so it is read by the
  // person who typed the sentence, in the language they typed it in.
  | 'rule.will-check.points-at-an-existing-row'
  | 'rule.will-check.is-never-missing'
  | 'rule.will-check.is-never-repeated'
  | 'rule.will-check.stays-within-its-usual-set'
  | 'rule.cannot'
  | 'rule.unsupported.needs_a_number'
  | 'rule.unsupported.needs_time'
  | 'rule.unsupported.needs_meaning'
  | 'rule.unsupported.needs_another_system'
  | 'rule.unsupported.not_about_rows'
  | 'rule.unsupported.names_nothing_here'
  // ---- what one fact IS, for the person reading the answer ----
  //
  // 🟥 `EvidenceFact.label` is English on purpose — a model reads it inside
  // the fence. These are the same facts named for the READER, and they exist
  // because the first Vietnamese answer came out with English labels inside
  // it. A half-translated sentence is worse than an untranslated one.
  | 'fact.column'
  | 'fact.what-the-scan-says'
  | 'fact.confidence'
  | 'fact.how-measured'
  | 'fact.rows-examined'
  | 'fact.sampling'
  | 'fact.targets-checked'
  | 'fact.boundary'
  // ---- the scope strip ----
  | 'strip.tables-visible'
  | 'strip.tables-visible-no-total'
  | 'strip.targets-eligible'
  | 'strip.targets-eligible-unknown'
  | 'strip.targets-checked'
  | 'strip.targets-not-checked'
  | 'strip.rules-did-not-run'
  | 'strip.rule.did-not-run'
  | 'strip.rule.no-denominator'
  | 'strip.rule.none-exist'
  | 'strip.rule.raised-nothing'
  | 'strip.rule.not-reached'
  // ---- the coverage sentence ----
  | 'coverage.no-total'
  | 'coverage.all'
  | 'coverage.partial'
  // ---- what the connector could reach ----
  | 'scope.nothing-asked'
  | 'scope.granted-when-unknown'
  | 'scope.tables-in'
  | 'scope.refused'
  | 'scope.missing'
  | 'scope.not-looked-at'
  | 'scope.unreadable-tables'
  | 'scope.unreadable-columns'
  | 'scope.outside'
  | 'scope.outside-within-reach'
  // ---- Layer A ----
  | 'layer-a.fk.plain'
  | 'layer-a.fk.technical'
  | 'layer-a.check.plain'
  | 'layer-a.check.technical'
  | 'layer-a.index.unique.plain'
  | 'layer-a.index.plain'
  | 'layer-a.index.technical'
  | 'layer-a.constraint.none-eligible'
  | 'layer-a.constraint.none-checked'
  | 'layer-a.constraint.one-kept'
  | 'layer-a.constraint.all-kept'
  | 'layer-a.constraint.technical'
  | 'layer-a.index.none-visible'
  | 'layer-a.index.one-on'
  | 'layer-a.index.all-on'
  | 'layer-a.index.technical-negative'
  | 'layer-a.bound.constraints-checked'
  | 'layer-a.bound.by-ceiling'
  | 'layer-a.bound.unreadable'
  | 'layer-a.bound.already-validated'
  | 'layer-a.bound.no-indexes'
  | 'layer-a.bound.one-index'
  | 'layer-a.bound.all-indexes'
  | 'layer-a.bound.index-tail'
  // ---- Layer B ----
  | 'layer-b.counted'
  | 'layer-b.sampled'
  | 'layer-b.set-aside'
  | 'layer-b.tail-one'
  | 'layer-b.tail-many'
  | 'layer-b.technical'
  | 'layer-b.how.counted'
  | 'layer-b.how.sampled'
  | 'layer-b.question'
  | 'layer-b.aside.budget-ceiling'
  | 'layer-b.aside.query-failed'
  | 'layer-b.aside.empty-draw'
  | 'layer-b.aside.one-repeated-value'
  | 'layer-b.aside.match-rate-too-low';

export type Catalog = Record<MessageKey, (p: Params) => string>;

/**
 * A number as the reader's locale writes it.
 *
 * Vietnamese groups with `.` and English with `,`, and a report that says
 * "45,822,187" to a Vietnamese reader is asking them to parse a decimal point
 * in the wrong place. Kept here so no call site has to remember.
 */
export function num(n: number, lang: Lang): string {
  return n.toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US');
}

const CATALOGS: Record<Lang, Catalog> = { en: EN, vi: VI };

/**
 * One sentence, in one language.
 *
 * Throws on an unknown key rather than returning the key itself. A report with
 * `scan.cost` printed where a sentence should be is a report that shipped, and
 * the failure it represents — a rename that missed a call site — is one a test
 * catches only if the test happens to read that line.
 */
export function t(lang: Lang, key: MessageKey, params: Params = {}): string {
  const message = CATALOGS[lang][key];
  if (message === undefined) {
    throw new Error(
      `No message for "${key}" in "${lang}". Every key in MessageKey has to ` +
        `exist in every catalogue; a report half in one language is worse ` +
        `than a report in the wrong one, because the reader stops trusting ` +
        `the half they can read.`,
    );
  }
  return message(params);
}

/** A bound `t` for code that renders many sentences in one language. */
export type Translate = (key: MessageKey, params?: Params) => string;

export function translator(lang: Lang): Translate {
  return (key, params) => t(lang, key, params);
}

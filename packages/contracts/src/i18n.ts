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
 * runtime — produces a report that is one language except for the three
 * sentences nobody remembered, which is worse than a single-language report
 * because the reader stops trusting the parts they can read.
 *
 * ## One language, 2026-08-27 — Licensor's decision
 *
 * `vi.ts` existed and was complete: 167 keys, with a test refusing any key that
 * came back identical to its English twin. It was removed, and the reason is
 * not that it had gone wrong. Every new message key was costing a Vietnamese
 * sentence as well as an English one, and the product is sold in English.
 *
 * ⚠️ It burned no measurement, and that is worth writing down because it looks
 * like it should have: VS-7 — the only test this product has ever run with
 * real readers — was read in Vietnamese, but on a HAND translation made for
 * that round, never through this catalogue. `vi.ts` was written afterwards, in
 * response. Debt N46 is where the hand translation's disappearance is
 * recorded.
 *
 * 🟩 The seam is deliberately still here. `Lang` is threaded through twenty
 * three source files and recorded on every run, and none of that was removed:
 * a report is evidence, and evidence has to say what language it was written
 * in even when there is only one to choose. Bringing a language back is adding
 * a file and a name to `LANGS`, exactly as before.
 */

import { EN } from './messages/en.js';

/**
 * Languages this product can speak. Adding one is adding a file.
 *
 * ⚠️ This is what the product RENDERS. It is not what a history file may
 * CONTAIN — runs recorded before 2026-08-27 can carry `vi`, and the store's
 * `lang` column still admits it. See `vocabulary.test.ts`: those two sets were
 * compared for equality until this list shrank, and equality was the wrong
 * relation the moment one of them could.
 */
export const LANGS = ['en'] as const;
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
 *
 * ⚠️ Since 2026-08-27 English is also the only choice, so `LEDAR_LANG=vi`
 * lands in the same branch as `LEDAR_LANG=klingon` and renders English. That
 * is deliberately NOT special-cased: a function that returns a language has
 * nowhere to put a warning, and inventing one channel for one retired value
 * would outlive the reason it was added. Where a person finds out is the
 * ledger and the `LANGS` comment above.
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
  | 'head.you-asked'
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
  | 'rule.cannot'
  | 'rule.unsupported.needs_a_number'
  | 'rule.unsupported.needs_time'
  | 'rule.unsupported.needs_meaning'
  | 'rule.unsupported.needs_another_system'
  | 'rule.unsupported.not_about_rows'
  | 'rule.unsupported.names_nothing_here'
  // ---- what "empty" will mean for THIS column ----
  //
  // One sentence per member of `MissingAdmission`, and the predicate that
  // runs is built from the same closed value. See `missing-policy.ts`: the
  // meaning used to be written twice — a sentence here and an `IS NULL` in
  // the runner — and the two disagreed in shipped code.
  | 'rule.missing-means.text'
  | 'rule.missing-means.scalar'
  | 'rule.missing-means.structured'
  | 'rule.missing-means.unsupported'
  // ---- a user's own rule, after it RAN ----
  //
  // VS-6's other half. These are the only sentences in the product that
  // report on a rule the product did not choose, and every one of them says
  // so — a count against someone's own rule is not the database confirming
  // anything, and a reader who cannot tell those apart has been told the
  // wrong thing.
  | 'user-rule.found'
  | 'user-rule.none'
  | 'user-rule.nothing-to-check'
  | 'user-rule.technical'
  | 'user-rule.boundary'
  | 'scan.you-asked-preamble'
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
  // Boundaries for findings that DO raise something — debt N50. A count with
  // no boundary reads as "and this is the whole of it", which is the same
  // mistake as a negative with no boundary, pointed the other way.
  | 'layer-a.bound.fk-orphans'
  | 'layer-a.bound.check-violations'
  | 'layer-a.bound.index-state'
  // A clause, not a sentence: appended to the two counting boundaries when a
  // count stopped at its ceiling, and empty when nothing was cut. Separate so
  // a translator keeps one short phrase in step rather than two long ones.
  | 'layer-a.bound.ceiling'
  | 'layer-b.bound.counted'
  | 'layer-b.bound.sampled'
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
 * Different languages group digits differently — a report that says
 * "45,822,187" to a reader whose language uses `.` as the separator is asking
 * them to parse a decimal point in the wrong place. Kept here so no call site
 * has to remember.
 *
 * A `Record<Lang, …>` rather than the ternary on `'vi'` that stood here until
 * 2026-08-27, and the difference is not tidiness: adding a language to `LANGS`
 * now fails to COMPILE until somebody has said which locale groups its
 * numbers. A ternary would have gone on quietly answering `en-US` for it.
 */
const LOCALES: Record<Lang, string> = { en: 'en-US' };

export function num(n: number, lang: Lang): string {
  return n.toLocaleString(LOCALES[lang]);
}

const CATALOGS: Record<Lang, Catalog> = { en: EN };

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

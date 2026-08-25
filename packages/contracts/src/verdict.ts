/**
 * The sentence the reader was writing for themselves.
 *
 * VS-7 put two real reports in front of five people who are responsible for a
 * database and do not build them. Four read the near-empty one correctly. The
 * fifth read it as *"phần lớn database đang ổn"* — most of the database is
 * fine — off a report whose subject was 36 tables of which 18 held no rows.
 *
 * That reader was not careless. The report ended without a conclusion, so they
 * supplied one, and everything available to supply it from pointed the same
 * way. In reading order:
 *
 *     36 of 36 tables could be read — all of them.        reassuring
 *     18 of 36 tables hold no rows …                      the one caveat
 *     87 targets eligible · 87 checked · 0 not checked    reassuring
 *     The one constraint I could check is being kept      reassuring
 *     All 85 indexes I can see are switched on            reassuring
 *     Nothing stood out.                                  reassuring
 *
 * Five reassurances and one caveat, the caveat written in the passive voice
 * and sitting seventh from the top of a header block. A person who skims takes
 * the majority reading. The report did not lie to them; it left the last step
 * to them and stacked the evidence.
 *
 * ## Why a report needs a verdict at all
 *
 * The scope strip already bounds every sentence — but a boundary is not a
 * conclusion, and `_doc/05` §7's rule that disclosure must travel with the
 * conclusion it limits assumes there IS a conclusion for it to travel with.
 * There was not one. This is it, and it is the only place in the product where
 * the distinction the whole thing exists for is stated as a sentence rather
 * than implied by an absence:
 *
 *     zero because it is clean   ≠   zero because nothing was visible
 *
 * ## Four kinds of zero, and they must not read alike
 *
 * The scanner already distinguishes four internally — clean, not examined,
 * table had no rows, and rule could not state a denominator. Until now that
 * distinction died at the printer, where all four came out as the absence of
 * a finding. `kind` carries it to the reader.
 *
 * Kept pure, and kept here beside `scope-strip.ts`, for the same reason that
 * one is: it is a sentence that decides what a person believes about their own
 * database, so it is worth being able to test every branch of it without a
 * Postgres in the room.
 */

import { t } from './i18n.js';
import type { Lang } from './i18n.js';
import { emptyTablesLine } from './share.js';

/** What the printer knows by the time the report has been assembled. */
export type VerdictInput = {
  /**
   * Findings actually raised — facts and questions.
   *
   * Never negatives and never abstentions. Counting those here would let a
   * report that said *"I checked 40 things and can conclude nothing"* arrive
   * at the verdict for a report that found something, which is the exact
   * confusion debt N8 split the claim kinds to prevent.
   */
  raised: number;

  /** Tables inside the schemas that were scanned. */
  tablesTotal: number;

  /** Of those, how many hold no rows at all. */
  tablesEmpty: number;

  /**
   * Columns a data rule was pointed at whose table turned out to be empty.
   *
   * Counted apart from `tablesEmpty` because it is the sharper number: a
   * database can be half empty in tables nobody was going to examine anyway,
   * and that is a different sentence from a rule aiming at a column and
   * finding nothing to aim at.
   */
  columnsWithNoRows: number;

  /** Targets a rule was entitled to check and did not. */
  targetsNotChecked: number;
};

export type VerdictKind =
  /** No data anywhere. Nothing below is about data. */
  | 'nothing_seen'
  /** Raised nothing, and something was out of view while not raising it. */
  | 'silence_with_gaps'
  /** Raised nothing, and nothing was out of view. The only real all-clear. */
  | 'silence_is_clean'
  /** Raised something. */
  | 'raised';

export type Verdict = {
  kind: VerdictKind;

  /**
   * One sentence, and the one a reader who reads nothing else must come away
   * with. Written so that it survives being the only line that lands.
   */
  headline: string;

  /**
   * The measurable gaps behind the headline — counts, no interpretation.
   *
   * Never empty for a verdict that withholds an all-clear. A refusal to
   * reassure that does not say what it is withholding reads as hedging, and a
   * reader discounts hedging — which would put them back where VS-7 found
   * them, only now with a paragraph in the way.
   */
  gaps: string[];

  /**
   * What those gaps mean, for a reader who is deciding something.
   *
   * Kept apart from `gaps` so the caller can print the numbers in both of the
   * two places this verdict appears and the interpretation in only one. The
   * split is not tidiness. On the near-empty report the sentence *"an empty
   * table is not a clean one"* already occurs in Layer B's own boundary line;
   * printing the whole verdict at the top and the bottom put it on screen
   * three times inside sixty lines, and a paragraph a reader has already
   * skipped twice is a paragraph that has taught them to skip it.
   */
  meaning: string[];
};

/**
 * The gaps, in the order a reader can act on them.
 *
 * Empty tables first: it is the largest and the one most often mistaken for a
 * clean result. Unchecked targets last: it is the rarest, and it is already
 * itemised further up the report by name.
 */
function gapsIn(input: VerdictInput, lang: Lang): string[] {
  const out: string[] = [];

  if (input.tablesEmpty > 0 && input.tablesTotal > 0) {
    // The magnitude, said rather than left to be divided out. Below a quarter
    // it is deliberately not said at all — see share.ts for why the report has
    // no quarrel with a reader who reads 8 of 36 as "a few".
    out.push(
      emptyTablesLine(
        {
          plain: 'verdict.gap.empty-tables',
          withShare: 'verdict.gap.empty-tables.share',
        },
        input.tablesEmpty,
        input.tablesTotal,
        lang,
      ),
    );
  }

  if (input.columnsWithNoRows > 0) {
    out.push(t(lang, 'verdict.gap.empty-columns', { count: input.columnsWithNoRows }));
  }

  if (input.targetsNotChecked > 0) {
    out.push(t(lang, 'verdict.gap.not-checked', { count: input.targetsNotChecked }));
  }

  return out;
}

/**
 * The report's own reading of itself.
 *
 * Deliberately not called `summary`. A summary compresses what was said; this
 * states what may be concluded from it, and those come apart exactly where it
 * matters — the report that says least is the one whose conclusion needs the
 * most saying.
 */
export function reportVerdict(input: VerdictInput, lang: Lang = 'en'): Verdict {
  const gaps = gapsIn(input, lang);

  const everythingEmpty =
    input.tablesTotal > 0 && input.tablesEmpty === input.tablesTotal;

  if (everythingEmpty) {
    return {
      kind: 'nothing_seen',
      headline: t(lang, 'verdict.nothing-seen'),
      gaps: [t(lang, 'verdict.nothing-seen.all-empty', { total: input.tablesTotal })],
      meaning: [t(lang, 'verdict.nothing-seen.meaning')],
    };
  }

  if (input.raised === 0 && gaps.length > 0) {
    return {
      kind: 'silence_with_gaps',
      headline: t(lang, 'verdict.silence-with-gaps'),
      gaps,
      meaning: [t(lang, 'verdict.silence-with-gaps.meaning')],
    };
  }

  if (input.raised === 0) {
    return {
      kind: 'silence_is_clean',
      headline: t(lang, 'verdict.silence-is-clean'),
      gaps: [],
      meaning: [t(lang, 'verdict.silence-is-clean.meaning')],
    };
  }

  return {
    kind: 'raised',
    headline: t(lang, 'verdict.raised', { count: input.raised }),
    gaps,
    meaning: gaps.length > 0 ? [t(lang, 'verdict.raised.meaning')] : [],
  };
}

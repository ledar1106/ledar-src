/**
 * How big a count is against the whole it came out of — in words nobody has to
 * divide to read.
 *
 * ## The measurement this exists for
 *
 * VS-7, 2026-08-23. A report said *"18 of 36 tables hold no rows"*. One of the
 * five readers came away with *"chỉ có vài bảng trống"* — only a few empty
 * tables. Half a database became *a few*.
 *
 * That reading cannot be blamed on the reader, and it is worth being precise
 * about why, because the obvious diagnosis is the wrong one. The sentence was
 * not vague and it was not hedged: it carried both numbers, exactly. What it
 * asked for was a **division**, silently, from someone skimming a page about
 * their own database. `18` and `36` are two facts; `half` is the one fact they
 * were both there to convey, and it was the only one the report did not say.
 *
 * The confound this cannot claim to have settled: those five read a hand
 * translation, not the product's own output, and that translation was never
 * kept. Whether the compression came from the report's words or the
 * translator's is now unanswerable — the second round that would have split
 * them was cancelled on 2026-08-24. So this module does not rest on that
 * reader. It rests on something anyone can check by looking at the line: the
 * magnitude was left as arithmetic. `field-results.md` ⑰ carries the limit.
 *
 * ## Why not a percentage every time
 *
 * `50%` is exact and it is also a fourth numeral on a line that already has
 * three. Where a simple fraction is *exactly* true — and `18/36` is — the
 * fraction is the form a person reads without converting. Percentages are the
 * fallback for the shares no fraction names, not the preferred form.
 *
 * ## Why nothing is said below a quarter
 *
 * A reader who compresses `8 of 36` into *"a few"* has lost nothing: at that
 * size *a few* and *a fifth* lead to the same decision. The report has no
 * quarrel with them. It has a quarrel at a half, and the threshold marks the
 * place where being vague starts to be wrong rather than merely loose. One
 * threshold, one reason — and silence below it, because a line that fires on
 * every report stops being read.
 *
 * Every branch here is **exactly true or rounded by less than one point**, and
 * the raw counts are printed beside it at both call sites, so the reader can
 * always recover the number the words came from.
 */

import { t } from './i18n.js';
import type { Lang, MessageKey } from './i18n.js';

/**
 * The smallest share worth putting into words, as two integers.
 *
 * Integers rather than `0.25` so the comparison against it never rounds: at
 * exactly one in four the share IS said, and no float decides that.
 */
const FLOOR = { part: 1, whole: 4 } as const;

/**
 * The fractions a person reads as a quantity rather than as a calculation.
 *
 * Only these five, and only on an exact hit. *"About two thirds"* for 61% is a
 * sentence this product is not entitled to say — the whole reason the counts
 * are printed next to the words is that the words never round more than the
 * percentage fallback does.
 */
const EXACT: { key: MessageKey; num: number; den: number }[] = [
  { key: 'share.quarter', num: 1, den: 4 },
  { key: 'share.third', num: 1, den: 3 },
  { key: 'share.half', num: 1, den: 2 },
  { key: 'share.two-thirds', num: 2, den: 3 },
  { key: 'share.three-quarters', num: 3, den: 4 },
];

/**
 * `part` of `total`, said as a quantity — or `null` when the counts already
 * say it better than any word could.
 *
 * `null` is not a failure and callers must not paper over it with a default:
 * it is the answer for every share small enough that stating it adds a clause
 * and no information. The two call sites carry two message keys apiece for
 * exactly that reason.
 */
export function shareInWords(part: number, total: number, lang: Lang): string | null {
  if (total <= 0 || part <= 0) return null;

  // At or above the whole. Neither call site can reach this — both sit behind
  // a branch that has already sent an all-empty database somewhere else
  // entirely — but a function that returns "100%" for a count that overran its
  // own total would be lying quietly, and this is cheaper than trusting the
  // callers to stay that way.
  if (part >= total) return t(lang, 'share.all');

  if (part * FLOOR.whole < total * FLOOR.part) return null;

  for (const fraction of EXACT) {
    if (part * fraction.den === total * fraction.num) return t(lang, fraction.key);
  }

  const percent = Math.round((part * 100) / total);

  // 99.6% of a database rounds to 100, and "100%" beside a count that is not
  // the total reads as a contradiction the reader has to resolve. They should
  // not have to.
  if (percent >= 100) return t(lang, 'share.almost-all');

  // Not through the catalogue: `53%` is identical in every language this
  // product speaks, and i18n.test.ts is right to refuse identical entries —
  // a bare numeral is interpolated INTO a sentence, it is not one.
  return `${percent}%`;
}

/**
 * The empty-tables line, for either of the two places the report states it.
 *
 * The report says this fact twice: once in the header block, and once in the
 * verdict. Both go through here rather than each choosing its own key, and the
 * reason is not tidiness. Neither site being wrong on its own is the failure
 * worth guarding against — it is the two **drifting**, so that the verdict
 * says *half of them* and the header line ten lines above says *18 of 36*.
 * One reader, one fact, two magnitudes, and no way to tell which one to
 * believe. There is one branch here, so there is one answer.
 */
export function emptyTablesLine(
  keys: { plain: MessageKey; withShare: MessageKey },
  empty: number,
  total: number,
  lang: Lang,
): string {
  const share = shareInWords(empty, total, lang);
  return share === null
    ? t(lang, keys.plain, { empty, total })
    : t(lang, keys.withShare, { empty, total, share });
}

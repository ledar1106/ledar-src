/**
 * The magnitude a reader would otherwise have to divide out.
 *
 * VS-7 measured a report saying *"18 of 36 tables hold no rows"* being read as
 * *"a few empty tables"*. Everything here is about one property: whenever this
 * function speaks, what it says is **true** — because a report that rounds a
 * third up to a half to sound clearer has traded the only thing it sells.
 *
 * So the assertions come in two halves, and the second half matters more:
 *
 *   it says the right thing when it speaks
 *   it says NOTHING rather than something nearly true
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LANGS, t } from '../src/i18n.js';
import { emptyTablesLine, shareInWords } from '../src/share.js';

/** The two places the report states the same fact about empty tables. */
const HEADER = {
  plain: 'scan.tables-empty-line',
  withShare: 'scan.tables-empty-line.share',
} as const;
const VERDICT = {
  plain: 'verdict.gap.empty-tables',
  withShare: 'verdict.gap.empty-tables.share',
} as const;

describe('saying how big a count is', () => {
  it('names the fraction that failed VS-7', () => {
    // The report a real person read as "chỉ có vài bảng trống". 18 and 36 were
    // both on the page; `half` was the fact they were there to convey.
    assert.equal(shareInWords(18, 36, 'en'), 'half');
    assert.equal(shareInWords(18, 36, 'vi'), 'một nửa');
  });

  it('uses a fraction only when the fraction is exact', () => {
    assert.equal(shareInWords(1, 4, 'en'), 'a quarter');
    assert.equal(shareInWords(1, 3, 'en'), 'a third');
    assert.equal(shareInWords(2, 3, 'en'), 'two thirds');
    assert.equal(shareInWords(3, 4, 'en'), 'three quarters');

    // One table off a third, out of ninety. "About a third" would be a fair
    // thing for a person to say and not a thing this product may print: it is
    // the same rounding-towards-comfort the whole module exists to refuse.
    assert.equal(shareInWords(31, 90, 'en'), '34%');
  });

  it('falls back to a percentage that is off by less than a point', () => {
    for (const [part, total] of [
      [7, 20],
      [31, 90],
      [53, 100],
      [899, 1000],
    ] as const) {
      const said = shareInWords(part, total, 'en');
      assert.ok(said !== null, `${part}/${total} should have been stated`);
      const claimed = Number(/^(\d+)%$/.exec(said)?.[1] ?? NaN);
      const truth = (part * 100) / total;
      assert.ok(
        Math.abs(claimed - truth) <= 0.5,
        `said ${said} for ${part}/${total}, which is ${truth.toFixed(2)}%`,
      );
    }
  });

  it('stays silent below a quarter, where "a few" is a fair reading', () => {
    // Not a gap in coverage. At this size a reader who compresses the count
    // reaches the same decision, and a line that fires on every report is a
    // line that stops being read.
    assert.equal(shareInWords(8, 36, 'en'), null);
    assert.equal(shareInWords(1, 5, 'en'), null);
    assert.equal(shareInWords(1, 1000, 'en'), null);

    // Exactly one in four is said. The boundary is compared as integers so no
    // float decides which side of it a database lands on.
    assert.equal(shareInWords(1, 4, 'en'), 'a quarter');
    assert.equal(shareInWords(250, 1000, 'en'), 'a quarter');
    assert.equal(shareInWords(249, 1000, 'en'), null);
  });

  it('never says a whole number of hundreds for a part that is not the whole', () => {
    // 999 of 1000 rounds to 100%, and "100%" beside a count that is not the
    // total reads as a contradiction the reader has to resolve for us.
    assert.equal(shareInWords(999, 1000, 'en'), 'almost all');
    assert.equal(shareInWords(1000, 1000, 'en'), 'all');
  });

  it('refuses counts that cannot be a share of anything', () => {
    assert.equal(shareInWords(0, 36, 'en'), null);
    assert.equal(shareInWords(5, 0, 'en'), null);
    assert.equal(shareInWords(-1, 36, 'en'), null);
  });

  it('speaks every language the product speaks, and differently', () => {
    // A quantity left in English inside a Vietnamese report is exactly the
    // half-translated page i18n.test.ts exists to refuse — but that gate only
    // sees the catalogue, and this function decides which catalogue entry is
    // reached. Same check, on this side of the choice.
    for (const [part, total] of [
      [18, 36],
      [1, 4],
      [2, 3],
      [999, 1000],
    ] as const) {
      const said = LANGS.map((lang) => shareInWords(part, total, lang));
      assert.ok(
        new Set(said).size === LANGS.length,
        `${part}/${total} reads the same in more than one language: ${said.join(' · ')}`,
      );
    }

    // The percentage fallback is the one form that IS identical everywhere,
    // and deliberately: it is a numeral, and numerals are interpolated into
    // sentences rather than translated.
    assert.equal(shareInWords(53, 100, 'en'), shareInWords(53, 100, 'vi'));
  });
});

describe('the two places the report states the same empty-table count', () => {
  it('agrees with itself about how big the number is', () => {
    // The failure worth guarding against is not either line being wrong on
    // its own. It is the header saying "18 of 36" while the verdict, ten
    // lines below, says "half of them" — one reader, one fact, two
    // magnitudes, and nothing to say which one to believe.
    for (const [empty, total] of [
      [18, 36],
      [8, 36],
      [1, 4],
      [31, 90],
      [999, 1000],
    ] as const) {
      for (const lang of LANGS) {
        const share = shareInWords(empty, total, lang);
        const header = emptyTablesLine(HEADER, empty, total, lang);
        const verdict = emptyTablesLine(VERDICT, empty, total, lang);

        if (share === null) {
          // Compared against the plain rendering rather than sniffed for
          // punctuation: the Vietnamese sentence uses an em dash of its own,
          // and a test that reads a dash as evidence of a magnitude is a test
          // that fails on grammar.
          assert.equal(header, t(lang, HEADER.plain, { empty, total }));
          assert.equal(verdict, t(lang, VERDICT.plain, { empty, total }));
        } else {
          assert.ok(
            header.includes(share) && verdict.includes(share),
            `${lang} ${empty}/${total}: "${share}" reached one line and not ` +
              `the other\n  header:  ${header}\n  verdict: ${verdict}`,
          );
        }
      }
    }
  });

  it('always prints both raw counts, whichever wording it chose', () => {
    // The words are the addition, never the replacement. A reader who wants
    // the number this product actually measured must be able to find it.
    for (const [empty, total] of [
      [18, 36],
      [8, 36],
    ] as const) {
      for (const keys of [HEADER, VERDICT]) {
        const said = emptyTablesLine(keys, empty, total, 'en');
        assert.match(said, new RegExp(`\\b${empty}\\b`), said);
        assert.match(said, new RegExp(`\\b${total}\\b`), said);
      }
    }
  });
});

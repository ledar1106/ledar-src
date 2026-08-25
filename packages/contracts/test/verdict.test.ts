/**
 * The verdict, branch by branch.
 *
 * This function exists because of one measured failure: VS-7, 2026-08-23, a
 * reader concluding *"most of the database is fine"* from a report about 36
 * tables of which 18 held no rows. So the assertions that matter most here are
 * not about wording — they are about two verdicts never being able to read
 * alike:
 *
 *     zero because it is clean   ≠   zero because nothing was visible
 *
 * A test that only checked "a verdict comes back" would stay green through the
 * exact regression this file is for.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reportVerdict } from '../src/verdict.js';
import type { VerdictInput } from '../src/verdict.js';

/** Nothing raised, nothing hidden — the only shape entitled to reassure. */
const CLEAN: VerdictInput = {
  raised: 0,
  tablesTotal: 12,
  tablesEmpty: 0,
  columnsWithNoRows: 0,
  targetsNotChecked: 0,
};

/**
 * The report a real person read as "fine", to the number.
 *
 * crates_io as scanned on 2026-08-22: 36 tables, 18 of them empty, and the one
 * Layer B candidate column sitting in a table with no rows.
 */
const REPORT_B: VerdictInput = {
  raised: 0,
  tablesTotal: 36,
  tablesEmpty: 18,
  columnsWithNoRows: 1,
  targetsNotChecked: 0,
};

describe('the verdict a reader concludes from', () => {
  it('does not let silence-because-clean and silence-because-blind read alike', () => {
    const clean = reportVerdict(CLEAN);
    const blind = reportVerdict(REPORT_B);

    assert.equal(clean.kind, 'silence_is_clean');
    assert.equal(blind.kind, 'silence_with_gaps');

    // The distinction has to survive into the sentence, not just the tag. A
    // reader never sees `kind`.
    assert.notEqual(clean.headline, blind.headline);
  });

  it('names every gap it is withholding an all-clear over', () => {
    const v = reportVerdict(REPORT_B);

    // Refusing to reassure without saying what is being withheld reads as
    // hedging, and readers discount hedging.
    assert.ok(v.gaps.length > 0, 'a withheld all-clear must say what it is withholding');

    const said = v.gaps.join(' ');
    assert.match(said, /18 of the 36 tables/);
    assert.match(said, /1 column/);
  });

  it('carries the count into the sentence, not just a vague "some"', () => {
    // The reader who failed VS-7 compressed "18 of 36" into "a few empty
    // tables". Whatever else changes, the verdict states the number.
    const said = reportVerdict(REPORT_B).gaps.join(' ');
    assert.match(said, /\b18\b/);
    assert.match(said, /\b36\b/);
  });

  it('states how big the gap is instead of leaving it as a division', () => {
    // The other half of the same VS-7 failure, and the half the counts alone
    // never fixed: `18` and `36` were both printed, and the fact they were
    // there to convey — that this is HALF the database — was not. A reader
    // skimming a page about their own system does not stop to divide.
    assert.match(reportVerdict(REPORT_B).gaps.join(' '), /half of them/);

    // And it stays quiet where the counts already say it. Eight of thirty-six
    // read as "a few" leads the reader to the same decision; a magnitude
    // clause on every report is a clause that stops being read.
    const few = reportVerdict({ ...REPORT_B, tablesEmpty: 8 });
    assert.doesNotMatch(few.gaps.join(' '), / of them —/);
    assert.match(few.gaps.join(' '), /8 of the 36 tables/);
  });

  it('separates the counts from what they mean', () => {
    const v = reportVerdict(REPORT_B);

    // The caller prints `gaps` in two places and `meaning` in one. If the
    // interpretation leaked into `gaps` it would appear three times in a
    // sixty-line report, counting Layer B's own boundary line.
    assert.ok(v.meaning.length > 0);
    assert.ok(
      !v.gaps.join(' ').includes('An empty table is not a clean one'),
      'interpretation belongs in `meaning`, which is printed once',
    );
  });

  it('treats an all-empty database as a statement about nothing', () => {
    const v = reportVerdict({
      raised: 0,
      tablesTotal: 9,
      tablesEmpty: 9,
      columnsWithNoRows: 0,
      targetsNotChecked: 0,
    });
    assert.equal(v.kind, 'nothing_seen');
    assert.match(v.headline, /there is no data/);
  });

  it('does not call a database empty when it has no tables at all', () => {
    // 0 === 0 is the arithmetic that made debt N39's mutation test go green
    // on a fixture with no empty table in it. An empty schema is not a
    // database whose every table is empty, and the two need different words.
    const v = reportVerdict({
      raised: 0,
      tablesTotal: 0,
      tablesEmpty: 0,
      columnsWithNoRows: 0,
      targetsNotChecked: 0,
    });
    assert.notEqual(v.kind, 'nothing_seen');
  });

  it('still names the gaps when something WAS raised', () => {
    const v = reportVerdict({ ...REPORT_B, raised: 3 });
    assert.equal(v.kind, 'raised');
    assert.match(v.headline, /I raised 3 things/);
    // A finding on the page does not make the blind spots stop existing.
    assert.ok(v.gaps.length > 0);
  });

  it('says nothing extra when something was raised and nothing was hidden', () => {
    const v = reportVerdict({ ...CLEAN, raised: 1 });
    assert.equal(v.kind, 'raised');
    assert.match(v.headline, /I raised 1 thing\./);
    assert.equal(v.gaps.length, 0);
    assert.equal(v.meaning.length, 0);
  });

  it('counts unchecked targets as a gap in their own right', () => {
    const v = reportVerdict({ ...CLEAN, targetsNotChecked: 4 });
    assert.equal(v.kind, 'silence_with_gaps');
    assert.match(v.gaps.join(' '), /4 targets/);
  });

  it('agrees with itself in number', () => {
    const one = reportVerdict({
      raised: 1,
      tablesTotal: 5,
      tablesEmpty: 1,
      columnsWithNoRows: 1,
      targetsNotChecked: 1,
    });
    const said = one.gaps.join(' ');
    assert.match(said, /1 of the 5 tables holds no rows/);
    assert.match(said, /1 column that a data rule was aiming at/);
    assert.match(said, /1 target a rule was entitled to check was not checked/);
    assert.match(one.headline, /I raised 1 thing\. Whether it is a problem/);
  });

  it('never returns a headline a reader could mistake for an all-clear', () => {
    // Every shape that is not `silence_is_clean` must avoid saying the
    // database is fine. The one that IS clean still only claims it within
    // the scope the strip states, which the caller prints directly beneath.
    for (const input of [
      REPORT_B,
      { ...REPORT_B, raised: 2 },
      { raised: 0, tablesTotal: 4, tablesEmpty: 4, columnsWithNoRows: 0, targetsNotChecked: 0 },
    ]) {
      const v = reportVerdict(input);
      assert.doesNotMatch(v.headline, /\bfine\b|\ball good\b|\bhealthy\b|\bno problems\b/i);
    }
  });
});

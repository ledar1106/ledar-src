/**
 * The line a reader sees when the model step did not happen — HS-D D.5.
 *
 * The plan for D.5 said *"fall back to templates and say clearly that you are
 * running degraded"*. That plan was written before VS-7, and VS-7 measured the
 * opposite ordering: four of five readers took the right conclusion off a
 * report produced entirely by hand-written rule packs, and the model path has
 * never been measured at all because it has never existed.
 *
 * So this file's central assertion is a refusal. Not *"the wording is nice"* —
 * that would be a test pinned to prose, which fails for reasons that mean
 * nothing. The assertion is that **no sentence here grades the report**, in
 * either language, and that a sentence which does cannot get through the gate.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LANGS } from '../src/i18n.js';
import {
  MODEL_STEP_STATES,
  ReportDisparaged,
  assertDoesNotDisparage,
  modelStepLine,
} from '../src/model-step.js';

describe('what the report says about a model step that did not run', () => {
  it('says nothing when nothing is missing', () => {
    // Two states, one reason each, and they land in the same place.
    //   answered        the addition is on the page; a line saying "this
    //                   worked" would ride along on every scan
    //   not_configured  nothing was expected, so nothing is missing
    for (const lang of LANGS) {
      assert.equal(modelStepLine('answered', lang), null);
      assert.equal(modelStepLine('not_configured', lang), null);
    }
  });

  it('speaks when something a reader was going to get did not arrive', () => {
    // Saying nothing here would be the opposite mistake: a hole a reader
    // cannot see is the one failure this product cannot absorb.
    for (const lang of LANGS) {
      for (const state of ['unavailable', 'declined'] as const) {
        const line = modelStepLine(state, lang);
        assert.ok(line, `${lang}/${state} said nothing about a real gap`);
        assert.ok(line.length > 40, `${lang}/${state} is too short to be a reason`);
      }
    }
  });

  it('never grades the report, in any language, in any state', () => {
    // The assertion this file exists for. Run through the gate itself rather
    // than a second copy of its word list — a copy would be the drift the gate
    // was built to stop.
    for (const lang of LANGS) {
      for (const state of MODEL_STEP_STATES) {
        const line = modelStepLine(state, lang);
        if (line === null) continue;
        assertDoesNotDisparage(line, `the ${state} line in ${lang}`);
      }
    }
  });

  it('speaks each language differently', () => {
    // The same check i18n.test.ts makes over the catalogue, on this side of
    // the choice of which entry gets reached.
    for (const state of ['unavailable', 'declined'] as const) {
      const said = LANGS.map((lang) => modelStepLine(state, lang));
      assert.equal(new Set(said).size, LANGS.length, `${state} reads alike`);
    }
  });

  it('distinguishes could-not-reach from would-not-send', () => {
    // Two different facts about somebody's system, and a reader deciding
    // whether to trust this build needs them apart: one is an outage, the
    // other is this product declining on their behalf.
    assert.notEqual(modelStepLine('unavailable'), modelStepLine('declined'));
    assert.match(String(modelStepLine('declined')), /third party|will not/i);
  });
});

describe('the gate on grading the report', () => {
  it('refuses the word the original plan told us to print', () => {
    // "degraded" is what D.5 said, and what every other system prints. On the
    // evidence this product actually has, it is false.
    assert.throws(
      () => assertDoesNotDisparage('Running in degraded mode.', 'a status line'),
      ReportDisparaged,
    );
  });

  it('refuses the same claim in Vietnamese', () => {
    // A gate that reads one language guards half a report — AGENTS §4.9 ①.
    assert.throws(
      () => assertDoesNotDisparage('Báo cáo này đang giảm cấp.', 'một dòng'),
      ReportDisparaged,
    );
  });

  it('refuses the other ways of saying it', () => {
    for (const said of [
      'This is a reduced report.',
      'a partial report only',
      'best-effort output',
      'the result is worse than usual',
      'bản báo cáo sơ sài hơn bình thường',
      'chế độ dự phòng',
    ]) {
      assert.throws(
        () => assertDoesNotDisparage(said, 'a line'),
        ReportDisparaged,
        `${JSON.stringify(said)} was allowed through`,
      );
    }
  });

  it('allows naming the gap, which is the whole point', () => {
    // The rule is narrow: name what did not get ADDED, never grade what is
    // there. These say exactly that and must pass.
    for (const said of [
      'A plain-language summary would normally be added here, and was not.',
      'Bình thường ở đây sẽ có thêm một đoạn tóm tắt, và lần này thì không.',
      'The model could not be reached.',
    ]) {
      assert.doesNotThrow(() => assertDoesNotDisparage(said, 'a line'));
    }
  });

  it('throws rather than quietly rewriting', () => {
    // A gate that repairs its input is a gate whose rule nobody learns, and
    // this rule has to be learned: the next person writing a status line will
    // reach for "degraded" in good faith.
    assert.throws(
      () => assertDoesNotDisparage('degraded', 'x'),
      (err: unknown) =>
        err instanceof ReportDisparaged &&
        /VS-7/.test((err as Error).message) &&
        /Name what was not added/.test((err as Error).message),
    );
  });
});

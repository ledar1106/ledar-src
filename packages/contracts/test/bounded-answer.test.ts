/**
 * The shape that replaces a word list — HS-D, VS-8.
 *
 * The bake-off measured six models on whether their prose broke hard rule ③.
 * The language gate caught 0 of 32; the word gate caught 6, of which five were
 * the model DENYING it was an error. A word ban does not read negation, and
 * the fix this project uses for its own prose — rewrite the sentence — is not
 * available for a model's.
 *
 * So the assertions here are not about words at all. They are about a model
 * being unable to say the wrong thing because it is never asked for a
 * sentence, in any language, including languages nobody here can read.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LANGS } from '../src/i18n.js';
import {
  AnswerRefused,
  factsFromFinding,
  MISSING_KINDS,
  renderAnswer,
  sealAnswer,
} from '../src/bounded-answer.js';
import type { EvidenceFact } from '../src/bounded-answer.js';
import { assertNoDefectWords } from '../src/findings.js';

/** The real finding, as facts under names this product owns. */
const OFFERED: EvidenceFact[] = [
  { id: 'rows_examined', label: 'how many rows', labelKey: 'fact.rows-examined', value: '49148' },
  { id: 'sampling', label: 'counted or sampled', labelKey: 'fact.sampling', value: 'every row counted' },
  { id: 'column', label: 'which column', labelKey: 'fact.column', value: 'public.votes.post_id' },
  { id: 'confidence', label: 'how sure', labelKey: 'fact.confidence', value: 'unconfirmed' },
];

describe('what a model is allowed to hand back', () => {
  it('accepts an answer that rests on facts it was given', () => {
    const sealed = sealAnswer(
      { answerable: true, facts: ['rows_examined', 'column'], missing: [] },
      OFFERED,
    );
    assert.equal(sealed.answerable, true);
    assert.deepEqual(sealed.facts, ['rows_examined', 'column']);
  });

  it('refuses a fact nobody offered', () => {
    // The structured form of "did it hallucinate". Unlike that question about
    // prose, this one has an exact answer.
    assert.throws(
      () =>
        sealAnswer(
          { answerable: true, facts: ['rows_examined', 'user_email'], missing: [] },
          OFFERED,
        ),
      (err: unknown) =>
        err instanceof AnswerRefused && /user_email/.test((err as Error).message),
    );
  });

  it('refuses a claim that rests on nothing', () => {
    assert.throws(
      () => sealAnswer({ answerable: true, facts: [], missing: [] }, OFFERED),
      AnswerRefused,
    );
  });

  it('refuses a refusal that will not say what is missing', () => {
    // Hedging without naming the gap is what a reader discounts, and VS-7
    // measured what discounted hedging costs.
    assert.throws(
      () => sealAnswer({ answerable: false, facts: [], missing: [] }, OFFERED),
      AnswerRefused,
    );
  });

  it('refuses an answer that is both answerable and not', () => {
    assert.throws(
      () =>
        sealAnswer(
          { answerable: true, facts: ['column'], missing: ['who'] },
          OFFERED,
        ),
      AnswerRefused,
    );
  });

  it('refuses a gap kind that has no sentence behind it', () => {
    assert.throws(
      () =>
        sealAnswer({ answerable: false, facts: [], missing: ['vibes'] }, OFFERED),
      AnswerRefused,
    );
  });

  it('refuses prose smuggled in beside the fields', () => {
    // `.strict()` earns its place here. A model that adds `explanation` is a
    // model trying to write the sentence, and knowing that is worth more than
    // dropping the key quietly.
    assert.throws(
      () =>
        sealAnswer(
          {
            answerable: false,
            facts: [],
            missing: ['who'],
            explanation: 'this looks like a data-entry error',
          },
          OFFERED,
        ),
      AnswerRefused,
    );
  });

  it('refuses an unparseable answer rather than salvaging part of it', () => {
    for (const raw of [null, 'ok', 42, { answerable: 'yes' }, {}]) {
      assert.throws(() => sealAnswer(raw, OFFERED), AnswerRefused);
    }
  });
});

describe('the sentence the reader actually sees', () => {
  it('contains no word the model produced', () => {
    // The property the whole design exists for. Every rendering, in every
    // language, of every gap kind — and none of it can carry a model's words,
    // because a model never supplies any.
    for (const lang of LANGS) {
      for (const kind of MISSING_KINDS) {
        const sealed = sealAnswer(
          { answerable: false, facts: [], missing: [kind] },
          OFFERED,
        );
        const said = renderAnswer(sealed, OFFERED, lang);
        assert.ok(said.length > 20, `${lang}/${kind} rendered nothing usable`);
        assertNoDefectWords(said, `the ${kind} refusal in ${lang}`);
      }
    }
  });

  it('holds hard rule 3 without a word list being consulted', () => {
    // A model CANNOT produce "this is an error" through this path, in any
    // language, including the eighteenth market where nobody here could
    // review a banned-word list. It is not that the words are filtered — it
    // is that no field carries words.
    for (const lang of LANGS) {
      const sealed = sealAnswer(
        { answerable: true, facts: ['rows_examined', 'sampling'], missing: [] },
        OFFERED,
      );
      assertNoDefectWords(renderAnswer(sealed, OFFERED, lang), `the answer in ${lang}`);
    }
  });

  it('names the facts by the label this product gave them', () => {
    const sealed = sealAnswer(
      { answerable: true, facts: ['rows_examined', 'column'], missing: [] },
      OFFERED,
    );
    const said = renderAnswer(sealed, OFFERED, 'en');
    assert.match(said, /how many rows the finding rests on/);
    assert.match(said, /which column this is about/);
    // The id is machinery, not something a reader should meet.
    assert.doesNotMatch(said, /rows_examined/);
  });

  // 🟥 THREE TESTS STOOD HERE UNTIL 2026-08-27, and they are gone with `vi.ts`
  // rather than adapted, because each of them needed two languages to say
  // anything. Named here rather than deleted silently: what they were watching
  // is still true of this code, and nothing watches it now.
  //
  //   'carries no English into a Vietnamese sentence'
  //       The strongest of the three, and it caught a real fault: asking a
  //       question in Vietnamese came back as "dựa trên: how many rows the
  //       finding rests on và whether every row was counted" — English labels
  //       interpolated into a translated sentence, through a field nobody had
  //       thought of as prose. The fix is still in the code: `EvidenceFact`
  //       carries TWO names, `label` for the model inside an English-instructed
  //       fence and `labelKey` for the reader. A second language returning
  //       without this test returning would put that fault back in reach.
  //
  //   'joins a list the way each language joins one'
  //   'reads differently in each language'
  //       Both compared one language's output against another's. With one
  //       language there is nothing to compare, and an assertion that a set of
  //       size one has size one is worse than no assertion: it is green for a
  //       reason that has nothing to do with the subject (§4.3).
  //
  // Restoring a language means restoring these. `renderAnswer` still takes a
  // `Lang`, and `listOf` in the source still carries a note saying its grammar
  // branch was removed rather than never written.

  it('has a sentence for every gap kind, in every language', () => {
    // The gate that stops `MissingKind` growing a value with no sentence
    // behind it. `Catalog` refuses to compile on a missing key, so this
    // catches the other direction: a key that exists and renders nothing.
    for (const lang of LANGS) {
      for (const kind of MISSING_KINDS) {
        const sealed = sealAnswer(
          { answerable: false, facts: [], missing: [kind] },
          OFFERED,
        );
        assert.ok(
          renderAnswer(sealed, OFFERED, lang).length > 20,
          `${kind} has no sentence in ${lang}`,
        );
      }
    }
  });
});

describe('turning a finding into facts a model may cite', () => {
  /** A finding shaped like the real one, including the part that must not travel. */
  const FINDING = {
    rule: 'layer-b/undeclared-reference-with-unmatched-values',
    confidence: 'unconfirmed',
    confidenceBasis: 'full_count',
    schema: 'public',
    table: 'votes',
    columns: ['post_id'],
    plainText: '6,459 of 49,148 rows point at a post that does not exist.',
    // N50: every finding states the limit of the measurement behind it.
    boundary: 'Counted every row of that one column; nothing else was examined.',
    evidence: { rowCount: 49148, sampleSize: null },
    coverage: { checked: 13, eligible: 13 },
  };

  it('never carries a row value, however the finding was shaped', () => {
    // The assertion this function exists for. Sample rows are `never-leaves`,
    // and framePrompt would refuse them anyway — this is the second lock on
    // the one thing that cannot be got wrong once.
    const withSample = {
      ...FINDING,
      evidence: { rowCount: 49148, sampleSize: 8, sample: [{ post_id: 424242 }] },
    };
    const facts = factsFromFinding(withSample);
    const said = facts.map((f) => `${f.id} ${f.label} ${f.value}`).join(' ');
    assert.doesNotMatch(said, /424242/, 'a row value reached the facts');
    assert.ok(!facts.some((f) => f.id === 'sample'));
  });

  it('says whether every row was counted or a sample was drawn', () => {
    // A count and an extrapolation are not the same claim, and silence about
    // which is which is how the second gets read as the first.
    const counted = factsFromFinding(FINDING).find((f) => f.id === 'sampling');
    assert.match(String(counted?.value), /every row counted/);

    const sampled = factsFromFinding({
      ...FINDING,
      evidence: { rowCount: 49148, sampleSize: 9828 },
    }).find((f) => f.id === 'sampling');
    assert.match(String(sampled?.value), /sampled, 9828/);
  });

  it('produces ids that sealAnswer will accept', () => {
    // These names ARE the vocabulary the citation check runs over. A fact the
    // mapper emits and the sealer rejects would be a hole in both.
    const facts = factsFromFinding(FINDING);
    const sealed = sealAnswer(
      { answerable: true, facts: facts.map((f) => f.id), missing: [] },
      facts,
    );
    assert.equal(sealed.facts.length, facts.length);
  });

  it('keeps the boundary when a finding has one', () => {
    const facts = factsFromFinding({ ...FINDING, boundary: 'nothing here says it was intended' });
    assert.ok(facts.some((f) => f.id === 'boundary'));
    // And omits it rather than emitting an empty one, which would be a fact
    // that says nothing and can still be cited.
    assert.ok(!factsFromFinding({ ...FINDING, boundary: '   ' }).some((f) => f.id === 'boundary'));
  });

  it('survives a finding with no evidence at all', () => {
    // `negative` and `abstained` findings carry none, and they are exactly the
    // ones a person is most likely to ask about.
    const facts = factsFromFinding({ ...FINDING, evidence: null });
    assert.ok(facts.length > 0);
    assert.ok(!facts.some((f) => f.id === 'rows_examined'));
  });
});

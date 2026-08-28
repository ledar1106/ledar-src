/**
 * What a model is allowed to hand back — HS-D, VS-8, and the reason rule ③
 * stops needing a word list.
 *
 * ## The measurement that forced this shape
 *
 * The bake-off scored six models on whether their Vietnamese prose broke hard
 * rule ③. Two things came out of it, and the second is why this file exists:
 *
 * ```text
 * the language gate caught 0 of 32   every model wrote Vietnamese
 * the word gate caught 6, of which   the other five were the model DENYING
 *   1 was a real violation           it was an error — "chưa thể kết luận là
 *                                    lỗi" trips a ban on the word "lỗi"
 * ```
 *
 * A ban on words does not read negation. This project already knew that and
 * had already chosen the remedy: rewrite the sentence. That remedy is
 * available for the product's own prose and **not available for a model's**.
 *
 * And the Licensor named the wall it runs into: the market is global. Two
 * languages is two word lists. Twenty markets is twenty lists, each needing a
 * native speaker to write and maintain, each misreading negation in its own
 * way. The gate does not scale, and a gate that does not scale is a rule that
 * will quietly stop being enforced.
 *
 * ## So the model does not write the sentence
 *
 * It picks. Everything it returns is an identifier out of a set this product
 * defined, and the product renders the sentence from its own catalogue.
 *
 * ```text
 * model returns   { answerable: false, missing: ['who', 'when'] }
 * product renders the sentence, in whichever language was asked for
 * ```
 *
 * A model cannot call a finding an error, in any language, because it is never
 * asked for a sentence. Rule ③ stops being a gate and becomes a shape.
 *
 * Adding a market is then adding a **catalogue file** — the thing this project
 * already knows how to do, with `Catalog` refusing to compile when a key is
 * missing — rather than adding a word list nobody on the team can review.
 *
 * ## Why this does not throw away what VS-7 measured
 *
 * VS-7 put hand-written rule-pack prose in front of five people and four read
 * it correctly. That is the only writing this product has ever had evidence
 * for, and this design keeps it: the sentences a reader sees stay the ones a
 * person wrote and a gate measured. The model is moved to the job prose cannot
 * do — deciding **which** sentence, from evidence and a question.
 *
 * ## What is deliberately NOT here
 *
 * Free text. Not one field. The temptation is a `note` — "just a short reason,
 * we will check it" — and that field is where every property on this page
 * leaks out, in whichever language nobody reviews.
 */

import { z } from 'zod';

import { t } from './i18n.js';
import type { Lang, MessageKey } from './i18n.js';

/**
 * One fact the product handed to the model, under a name the product owns.
 *
 * `id` is what a model may refer to. `label` and `value` are what it may read.
 * The split matters: an answer citing `unmatched_rows` is checkable against
 * the list that was offered, and an answer citing a phrase is not.
 */
export type EvidenceFact = {
  id: string;
  /**
   * What this fact is, for the MODEL to read inside the fence.
   *
   * English, and staying English, for the reason `i18n.ts` gives about prompts:
   * nobody reads a prompt, a model does, and the instruction around it is
   * English machinery. Translating this half would vary the prompt by market
   * for no reader's benefit.
   */
  label: string;
  /**
   * What this fact is, for the PERSON who reads the answer.
   *
   * 🟥 Added 2026-08-25, after a Vietnamese answer came out reading
   * *"dựa trên: how many rows the finding rests on và whether every row was
   * counted"* — English labels interpolated into a Vietnamese sentence.
   * `i18n.ts` is explicit that a half-translated report is worse than an
   * untranslated one, because the reader stops trusting the half they can
   * read, and this was that exact failure arriving through a field nobody had
   * thought of as prose.
   *
   * Required, not optional. An optional key with a string fallback is the same
   * bug with a longer fuse.
   */
  labelKey: MessageKey;
  value: string;
};

/**
 * The kinds of thing a question can want that evidence may not carry.
 *
 * Closed, and short on purpose. It is not a taxonomy of everything a person
 * could ask — it is the set of gaps this product can name a sentence for, and
 * a value here has to earn a sentence in every catalogue before it is added.
 *
 * `elsewhere` is the honest catch-all: the question is about something outside
 * what was scanned at all. Without it, a model with no fitting value picks the
 * nearest wrong one, and a wrong gap reads worse than a vague one.
 */
export const MissingKind = z.enum([
  /** Which person, account or role. */
  'who',
  /** When it happened, or over what period. */
  'when',
  /** Why it happened — cause, intent, history. */
  'why',
  /** Which specific rows, by identity rather than by count. */
  'which_rows',
  /** What it costs, affects or is worth. */
  'impact',
  /** Something outside what was scanned. */
  'elsewhere',
]);
export type MissingKind = z.infer<typeof MissingKind>;

export const MISSING_KINDS = MissingKind.options;

/**
 * The whole of what a model may return.
 *
 * Three fields, no prose. `.strict()` so an extra key is a refusal rather than
 * something silently dropped: a model that adds `explanation` is a model
 * trying to write the sentence, and finding that out is worth more than
 * quietly ignoring it.
 */
export const BoundedAnswer = z
  .object({
    /** Whether the evidence supports an answer at all. */
    answerable: z.boolean(),
    /** Which offered facts the answer rests on. Ids only. */
    facts: z.array(z.string()),
    /** What the evidence does not carry. Only when `answerable` is false. */
    missing: z.array(MissingKind),
  })
  .strict();
export type BoundedAnswer = z.infer<typeof BoundedAnswer>;

export class AnswerRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswerRefused';
  }
}

declare const ANSWER_SEAL: unique symbol;

/**
 * An answer that has been checked against what was actually offered.
 *
 * The brand is the same device as `SealedFinding` and `SealedSetAside`, for
 * the same reason: the renderer accepts only this type, so an unchecked object
 * cannot reach a reader however tired whoever wrote the call site was.
 */
export type SealedAnswer = BoundedAnswer & {
  readonly [ANSWER_SEAL]: 'checked against the facts that were offered';
};

/**
 * Checks one answer against the facts it was given, or throws.
 *
 * The check that matters is `facts` against `offered`. A model returning an id
 * nobody handed it has invented a source — which is the structured form of the
 * thing "did it hallucinate" tries to ask about prose, and unlike that
 * question this one has an exact answer.
 */
export function sealAnswer(
  raw: unknown,
  offered: readonly EvidenceFact[],
): SealedAnswer {
  const parsed = BoundedAnswer.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AnswerRefused(
      `The model did not return the shape it was asked for: ` +
        `${issue?.path.join('.') || '(root)'} — ${issue?.message ?? 'wrong shape'}. ` +
        `An unparseable answer is a failed call, not a partial one.`,
    );
  }
  const answer = parsed.data;

  const ids = new Set(offered.map((f) => f.id));
  const invented = answer.facts.filter((f) => !ids.has(f));
  if (invented.length > 0) {
    throw new AnswerRefused(
      `The answer cites ${invented.map((i) => JSON.stringify(i)).join(', ')}, ` +
        `which ${invented.length === 1 ? 'was' : 'were'} never offered. The ` +
        `facts available were: ${[...ids].join(', ')}. Citing a source nobody ` +
        `supplied is inventing one, and it is the only form of that this ` +
        `product can detect exactly.`,
    );
  }

  if (answer.answerable && answer.facts.length === 0) {
    throw new AnswerRefused(
      `The answer says the evidence supports it and names no fact it rests ` +
        `on. That is a claim with nothing behind it — the shape this whole ` +
        `product exists to refuse.`,
    );
  }

  if (!answer.answerable && answer.missing.length === 0) {
    throw new AnswerRefused(
      `The answer says the evidence cannot support it and does not say what ` +
        `is absent. A refusal that will not name the gap is the hedging a ` +
        `reader discounts, and VS-7 measured what discounted hedging costs.`,
    );
  }

  if (answer.answerable && answer.missing.length > 0) {
    throw new AnswerRefused(
      `The answer is marked answerable and also lists what is missing. Those ` +
        `are two different answers, and picking one for the reader is not ` +
        `this renderer's job.`,
    );
  }

  return answer as SealedAnswer;
}

/**
 * Joins a list the way a language joins one.
 *
 * English wants an Oxford comma and "and"; Vietnamese wants "và" and no comma
 * before it. A shared `join(', ')` would be English grammar imposed on every
 * market, which is the same mistake as a shared template string — the reason
 * `i18n.ts` says the catalogue is functions.
 */
function listOf(parts: readonly string[], lang: Lang): string {
  if (parts.length <= 1) return parts[0] ?? '';
  const head = parts.slice(0, -1);
  const last = parts[parts.length - 1]!;
  return head.length === 1 ? `${head[0]} and ${last}` : `${head.join(', ')}, and ${last}`;
}
// ⚠️ `lang` is still the parameter and is deliberately still unused here.
//
// List grammar is one of two places per-language rules live OUTSIDE the message
// catalogue — the other is `num` in `i18n.ts` — and that was always the
// exception to the rule this product's i18n is built on: a function per message
// so each language solves its own grammar. A Vietnamese branch stood here until
// 2026-08-27 (`${head} và ${last}`); it went with `vi.ts`.
//
// Keeping the parameter rather than deleting it is the seam: the day a second
// language returns, the compiler points at every signature that has to think
// about it, and this is one of them.

/**
 * The sentence a reader sees, built by this product from the model's choices.
 *
 * Takes `SealedAnswer` and nothing else, so an answer that has not been checked
 * against the offered facts cannot be rendered — the ids interpolated below are
 * exactly the ids `sealAnswer` proved were real.
 *
 * Note what is NOT interpolated anywhere: any string the model produced. It
 * chose which of these sentences applies; every word in them was written here.
 */
export function renderAnswer(
  answer: SealedAnswer,
  offered: readonly EvidenceFact[],
  lang: Lang = 'en',
): string {
  if (answer.answerable) {
    const labels = answer.facts.map((id) =>
      t(lang, offered.find((f) => f.id === id)!.labelKey),
    );
    return t(lang, 'answer.rests-on', { facts: listOf(labels, lang) });
  }

  const gaps = answer.missing.map((kind) =>
    t(lang, `answer.missing.${kind}` as MessageKey),
  );
  return t(lang, 'answer.cannot', { missing: listOf(gaps, lang) });
}

/**
 * One finding, as the facts a model may cite — VS-8's input side.
 *
 * ## What is deliberately absent, and it is the whole point
 *
 * `evidence.sample` never appears here. Sample rows are row VALUES, which
 * `_doc/16` §2 classes `never-leaves`, and `framePrompt` would refuse a block
 * carrying them anyway. Leaving them out here as well is belt and braces on
 * the one thing this product cannot afford to get wrong once.
 *
 * What DOES go is identifiers, counts, and how the measurement was made —
 * `customer-system-metadata` in the same vocabulary. A model can answer
 * "what share of the rows" from a count without ever seeing a row.
 *
 * ## Why the ids are stable strings
 *
 * `sealAnswer` checks a cited id against the ids that were offered, so these
 * names are the vocabulary that check runs over. They read like column names
 * on purpose: a model citing `rows_unmatched` is checkable, and a model citing
 * "the number of broken links" is not.
 */
export function factsFromFinding(finding: {
  rule: string;
  confidence: string;
  confidenceBasis: string;
  schema: string;
  table: string;
  columns: readonly string[];
  plainText: string;
  evidence: { rowCount: number; sampleSize: number | null } | null;
  coverage: { checked: number; eligible: number | null };
  boundary?: string;
}): EvidenceFact[] {
  const facts: EvidenceFact[] = [
    {
      id: 'column',
      label: 'which column this is about',
      labelKey: 'fact.column',
      value:
        finding.columns.length > 0
          ? `${finding.schema}.${finding.table}.${finding.columns.join(', ')}`
          : `${finding.schema}.${finding.table}`,
    },
    {
      id: 'what_the_scan_says',
      label: 'what the scan already says about it',
      labelKey: 'fact.what-the-scan-says',
      value: finding.plainText,
    },
    {
      id: 'confidence',
      label: 'how sure the scan is',
      labelKey: 'fact.confidence',
      value: finding.confidence,
    },
    {
      id: 'how_measured',
      label: 'how it was measured',
      labelKey: 'fact.how-measured',
      value: finding.confidenceBasis,
    },
  ];

  if (finding.evidence) {
    facts.push({
      id: 'rows_examined',
      label: 'how many rows the finding rests on',
      labelKey: 'fact.rows-examined',
      value: String(finding.evidence.rowCount),
    });
    facts.push({
      id: 'sampling',
      label: 'whether every row was counted or a sample was drawn',
      labelKey: 'fact.sampling',
      // The distinction VS-4 exists for, in a form a model can cite: a count
      // and an extrapolation are not the same claim, and silence about which
      // is which is how the second gets read as the first.
      value:
        finding.evidence.sampleSize === null
          ? 'every row counted, no sampling'
          : `sampled, ${finding.evidence.sampleSize} rows drawn`,
    });
  }

  facts.push({
    id: 'targets_checked',
    label: 'how many targets this rule checked',
    labelKey: 'fact.targets-checked',
    value:
      finding.coverage.eligible === null
        ? String(finding.coverage.checked)
        : `${finding.coverage.checked} of ${finding.coverage.eligible}`,
  });

  if (finding.boundary !== undefined && finding.boundary.trim() !== '') {
    facts.push({
      id: 'boundary',
      label: 'what the scan says it cannot conclude',
      labelKey: 'fact.boundary',
      value: finding.boundary,
    });
  }

  return facts;
}

/**
 * What a model may hand back when a PERSON describes a rule — HS-D, VS-6.
 *
 * ## Why this is not `bounded-answer` with different field names
 *
 * VS-8 hands a model a question and some facts. An instruction hidden in that
 * question is **out of place**: the model was told to answer from evidence,
 * and a payload has to fight that framing to land. ㉒ measured what that costs
 * an attacker — five of six models refused to move at all.
 *
 * VS-6 hands a model a sentence the user typed to say *what should be true of
 * my data*, and asks for a rule. An instruction inside THAT is **in place**.
 * The whole field is an imperative by design; there is no framing for a
 * payload to fight. It is the strongest invitation to obey anywhere in this
 * product, and ㉓ already found the shape of the answer: the dangerous door is
 * the one framed as a command, not the one an attacker can write most words
 * into.
 *
 * ## And the failure is invisible, which VS-8's is not
 *
 * A wrong VS-8 answer is read by the person who asked. A wrong VS-6 rule
 * becomes a check that runs against their database and reports findings that
 * look exactly like every other finding. Nobody is standing there comparing it
 * to the sentence they typed a week ago.
 *
 * ## So the model picks; it does not write
 *
 * Same device as `bounded-answer`, for the same reason. Everything returned is
 * an identifier out of a set this product defined, or out of the CATALOGUE OF
 * THE DATABASE THAT WAS SCANNED. No SQL, no predicate text, no free field.
 *
 * ```text
 * model returns   { expressible: true, check: 'is-never-missing',
 *                   table: 'public.users', columns: ['email'] }
 * product renders the sentence, and the SQL, from its own vocabulary
 * ```
 *
 * ## 🟥 What this shape CANNOT catch, said before anything is measured
 *
 * `sealRule` proves a rule is *well formed and points at things that exist*.
 * It cannot prove the rule is *the one the user asked for*. A check of the
 * right kind, on a real table, naming real columns, about entirely the wrong
 * thing passes every assertion in this file — because from here `public.users`
 * and `public.badges` are two legal identifiers and nothing more.
 *
 * That door has no gate, and pretending otherwise is worse than leaving it
 * open. Two things stand in it instead:
 *
 * ```text
 * ① the model            measured, not assumed — infra/ai-form-check.ts
 *                        --attack-rule fires at exactly this door
 * ② the READ-BACK        `renderRule` says, in the product's own words and
 *                        the user's own language, what it is about to check.
 *                        The user confirms before it runs.
 * ```
 *
 * ② is a product decision and belongs argued with rather than buried: it costs
 * a screen in onboarding, and it is the only thing between a hijacked rule and
 * a database. A confirmation step nobody reads is worth little — but a rule
 * pointed at a table the user never mentioned is exactly the kind of wrong
 * that survives a careless read and dies on a careful one.
 *
 * ## What is deliberately NOT here
 *
 * A threshold. A number. A date. A `predicate` string. Any of them would let
 * the user's sentence through as *content*, and content is the thing this
 * whole design exists to keep out of the executable half.
 */

import { z } from 'zod';

import { t } from './i18n.js';
import { missingMeaningSentence } from './missing-policy.js';
import type { MissingAdmission } from './missing-policy.js';
import type { Lang, MessageKey } from './i18n.js';

/**
 * The checks this product can actually run from a sentence somebody typed.
 *
 * Closed, and SHORT — shorter than a first draft wants it. Every kind here is
 * something the scan engine already counts today, expressed over identifiers
 * alone. Nothing here needs a number from the user, and that is the membership
 * test: if a check needs the user's sentence to survive into execution, it
 * does not belong in this list.
 *
 * The honest consequence, which the measurement below is going to expose: MOST
 * business rules a person types are not in here. "Orders over $1000 need
 * approval" is not a rule this product can check, and the whole safety
 * property of VS-6 is that the model says so instead of finding something
 * nearby that fits.
 */
export const RuleCheck = z.enum([
  /** Every value in one column matches a row in another table. */
  'points-at-an-existing-row',
  /** No row leaves the column empty. */
  'is-never-missing',
  /** No two rows share a value. */
  'is-never-repeated',
]);

/**
 * 🟥 A fourth check was here and is gone — `stays-within-its-usual-set`,
 * removed 2026-08-25 on the day something first tried to RUN one of these.
 *
 * Its docstring justified it by saying *"the set comes from the DATA, not the
 * sentence — this is `layer-b/enum-drift`"*. That rule does not exist. It is a
 * string in a test fixture, and I cited it as an implementation. A citation
 * nobody followed is how a vocabulary grows an entry nothing can honour.
 *
 * And it is not merely unimplemented — as written it is VACUOUS. If the
 * allowed set is *the distinct values present when we looked*, every value is
 * in it by construction and the check can never find anything. It only means
 * something ACROSS TIME, when a later scan meets a value the earlier one did
 * not, and that is `npm run diff`, not a check a single scan can run.
 *
 * It survived two paid rounds (㉔, ㉕ — 132 shots) purely because no model
 * ever picked it. Nothing broke, and nothing would have, until the first
 * customer sentence mapped onto it and the executor had to refuse a rule the
 * seal had already approved.
 *
 * > **A vocabulary entry nothing can execute is a promise this product cannot
 * > keep**, and the seal accepting it makes the promise look checked.
 *
 * Removing it changes no measurement: 0 of 132 answers chose it and no
 * expected answer used it. It does shrink the option list in the prompt from
 * four to three, so a FUTURE round is not byte-comparable with ㉔ and ㉕ —
 * noted here rather than discovered later.
 */
export type RuleCheck = z.infer<typeof RuleCheck>;

export const RULE_CHECKS = RuleCheck.options;

/**
 * Why a sentence could not become a check.
 *
 * The same job `MissingKind` does for VS-8, and the same discipline: a value
 * here has to earn a sentence in every catalogue before it is added. Without
 * this list a model with nothing to say picks the nearest fitting check, and a
 * rule invented to avoid an awkward silence is the exact failure VS-6 has to
 * not have.
 */
export const UnsupportedKind = z.enum([
  /** It turns on an amount or threshold the scan has no way to judge. */
  'needs_a_number',
  /** It is about when things happened; a scan sees the database at one moment. */
  'needs_time',
  /** It depends on what a value MEANS to the business, not on what it is. */
  'needs_meaning',
  /** What it talks about is not in this database. */
  'needs_another_system',
  /** It is about people, process or permission rather than rows. */
  'not_about_rows',
  /** It does not name anything that exists here. */
  'names_nothing_here',
]);
export type UnsupportedKind = z.infer<typeof UnsupportedKind>;

export const UNSUPPORTED_KINDS = UnsupportedKind.options;

/**
 * The tables and columns a rule may name — the database that was scanned.
 *
 * Keyed `schema.table`, exactly the spelling a rule has to use. This is the
 * vocabulary `sealRule` checks against, and it is the reason a hijacked rule
 * naming `public.secrets` fails here rather than at query time.
 */
export type SchemaCatalog = Readonly<Record<string, readonly string[]>>;

/**
 * The whole of what a model may return.
 *
 * `.strict()`, so an extra key is a refusal rather than a silent drop — a
 * model that adds `sql` or `reason` is a model reaching for the executable
 * half, and finding that out is worth more than ignoring it.
 *
 * The nullable fields are nullable because the alternative is worse. An absent
 * `check` written as `''` is a check named the empty string, and the seal
 * would have to guess which one the model meant.
 */
export const BoundedRule = z
  .object({
    /** Whether this product can turn the sentence into a check at all. */
    expressible: z.boolean(),
    /** Which check. Null when it cannot be expressed. */
    check: z.union([RuleCheck, z.null()]),
    /** Which table, as `schema.table`. Null when it cannot be expressed. */
    table: z.union([z.string(), z.null()]),
    /** Which columns of that table. Empty when it cannot be expressed. */
    columns: z.array(z.string()),
    /** For `points-at-an-existing-row`: the `schema.table.column` pointed at. */
    references: z.union([z.string(), z.null()]),
    /** Why not. Only when `expressible` is false. */
    unsupported: z.array(UnsupportedKind),
  })
  .strict();
export type BoundedRule = z.infer<typeof BoundedRule>;

export class RuleRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleRefused';
  }
}

declare const RULE_SEAL: unique symbol;

/**
 * A rule checked against the catalogue of the database it will run on.
 *
 * Same brand device as `SealedAnswer` and `SealedFinding`: the renderer and
 * every future execution path take only this type, so an unchecked object
 * cannot reach a database however tired whoever wrote the call site was.
 */
export type SealedRule = BoundedRule & {
  readonly [RULE_SEAL]: 'checked against the catalogue it will run on';
};

/**
 * Splits `schema.table.column` into its table and column halves.
 *
 * Rightmost dot, because a schema or table name may legally contain one and a
 * column reference always ends in exactly one column.
 */
function splitReference(ref: string): { table: string; column: string } | null {
  const at = ref.lastIndexOf('.');
  if (at <= 0 || at === ref.length - 1) return null;
  return { table: ref.slice(0, at), column: ref.slice(at + 1) };
}

/**
 * Checks one rule against the catalogue it would run on, or throws.
 *
 * The check that carries is `table` and `columns` against `catalog`. A rule
 * naming a table nobody offered has invented a target — the same class of
 * failure as `sealAnswer` catching an invented fact id, and detectable in the
 * same exact way.
 *
 * What it cannot check is stated in the header of this file, and is measured
 * rather than asserted.
 */
export function sealRule(raw: unknown, catalog: SchemaCatalog): SealedRule {
  const parsed = BoundedRule.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RuleRefused(
      `The model did not return the shape it was asked for: ` +
        `${issue?.path.join('.') || '(root)'} — ${issue?.message ?? 'wrong shape'}. ` +
        `A rule this product cannot parse is a rule it must not run.`,
    );
  }
  const rule = parsed.data;

  if (!rule.expressible) {
    if (rule.unsupported.length === 0) {
      throw new RuleRefused(
        `The rule is marked inexpressible and says nothing about why. A ` +
          `refusal that will not name the gap leaves the user with no next ` +
          `step, and the next step is the only useful thing a refusal has.`,
      );
    }
    if (rule.check !== null || rule.table !== null || rule.columns.length > 0) {
      throw new RuleRefused(
        `The rule is marked inexpressible and still names a check to run. ` +
          `Those are two different answers, and choosing between them is not ` +
          `something a caller downstream should be doing.`,
      );
    }
    if (rule.references !== null) {
      throw new RuleRefused(
        `The rule is marked inexpressible and still names something for it ` +
          `to point at.`,
      );
    }
    return rule as SealedRule;
  }

  if (rule.unsupported.length > 0) {
    throw new RuleRefused(
      `The rule is marked expressible and also lists what stops it being ` +
        `expressed. Both cannot be true, and a reader shown both will believe ` +
        `the half that suits them.`,
    );
  }
  if (rule.check === null) {
    throw new RuleRefused(
      `The rule is marked expressible and names no check. There is nothing ` +
        `here to run.`,
    );
  }
  if (rule.table === null || !Object.hasOwn(catalog, rule.table)) {
    throw new RuleRefused(
      `The rule names table ${JSON.stringify(rule.table)}, which is not in ` +
        `the catalogue that was offered. The tables available were: ` +
        `${Object.keys(catalog).join(', ')}. Naming a table nobody supplied ` +
        `is inventing a target, and this product does not point a query at ` +
        `an invented one.`,
    );
  }

  const known = new Set(catalog[rule.table]);
  const unknown = rule.columns.filter((c) => !known.has(c));
  if (unknown.length > 0) {
    throw new RuleRefused(
      `The rule names ${unknown.map((c) => JSON.stringify(c)).join(', ')} on ` +
        `${rule.table}, which ${unknown.length === 1 ? 'is' : 'are'} not ` +
        `${unknown.length === 1 ? 'a column' : 'columns'} of it. That table ` +
        `has: ${[...known].join(', ')}.`,
    );
  }

  // Arity. Each kind takes exactly the columns it can mean something about,
  // and a check spread over columns the user did not name is a check that
  // reports on things they never asked about — which reads, in the report,
  // exactly like a thing they did.
  if (rule.columns.length === 0) {
    throw new RuleRefused(
      `The rule names a table and no column. Every check this product knows ` +
        `is a claim about a column.`,
    );
  }
  if (rule.check !== 'is-never-repeated' && rule.columns.length !== 1) {
    throw new RuleRefused(
      `Check ${JSON.stringify(rule.check)} is a claim about one column, and ` +
        `this rule names ${rule.columns.length}. Two columns are two rules ` +
        `with two denominators; merging them loses which one failed.`,
    );
  }

  if (rule.check === 'points-at-an-existing-row') {
    if (rule.references === null) {
      throw new RuleRefused(
        `The rule checks that values point at an existing row and does not ` +
          `say what they point at.`,
      );
    }
    const target = splitReference(rule.references);
    if (target === null || !Object.hasOwn(catalog, target.table)) {
      throw new RuleRefused(
        `The rule points at ${JSON.stringify(rule.references)}, which is not ` +
          `a column of any table in the catalogue. Expected ` +
          `schema.table.column, from: ${Object.keys(catalog).join(', ')}.`,
      );
    }
    if (!catalog[target.table]!.includes(target.column)) {
      throw new RuleRefused(
        `The rule points at ${JSON.stringify(rule.references)}, and ` +
          `${target.table} has no column ${JSON.stringify(target.column)}.`,
      );
    }
  } else if (rule.references !== null) {
    throw new RuleRefused(
      `Check ${JSON.stringify(rule.check)} does not point at anything, and ` +
        `this rule names ${JSON.stringify(rule.references)} for it to point ` +
        `at. A field that means nothing here is a field that will be read as ` +
        `meaning something.`,
    );
  }

  return rule as SealedRule;
}

/**
 * Joins a list the way a language joins one — see `bounded-answer.ts`.
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
 * What the product says it is about to check, for the user to confirm.
 *
 * This is control ② from the header, and the reason it takes `SealedRule` and
 * nothing else: the identifiers interpolated below are exactly the ones
 * `sealRule` proved exist.
 *
 * Note what is NOT interpolated: any string the model produced. It chose which
 * sentence and which identifiers; every word around them was written here, in
 * the language the reader asked for.
 */
export function renderRule(
  rule: SealedRule,
  /**
   * What "empty" will mean for this column, or `null` when the check does not
   * turn on it.
   *
   * 🟥 REQUIRED, and required is the whole point. `missing-policy.ts` exists
   * so the sentence and the SQL cannot disagree about what counts as empty —
   * and it was doing that job with **zero production callers**. The sentence
   * was generated, tested, and shown to nobody, while this function kept
   * emitting the older wording that says only "empty" and leaves the reader
   * to guess whether a column of spaces counts.
   *
   * A gate nobody calls is not a gate (AGENTS §4.3), and this one sat on the
   * single control the design says has to be read. So the parameter is not
   * optional: whoever builds the read-back has to answer *do I have the
   * admission?* at compile time rather than discover the clause missing after
   * a user has confirmed something.
   *
   * `null` is a real answer — `is-never-repeated` and
   * `points-at-an-existing-row` do not turn on emptiness — and it has to be
   * written out, so choosing it is a decision rather than an omission.
   */
  admission: MissingAdmission | null,
  lang: Lang = 'en',
): string {
  if (!rule.expressible) {
    const reasons = rule.unsupported.map((kind) =>
      t(lang, `rule.unsupported.${kind}` as MessageKey),
    );
    return t(lang, 'rule.cannot', { detail: listOf(reasons, lang) });
  }

  // Bare column names, and the table named once by the sentence itself. An
  // earlier draft qualified every column and produced "no two rows in
  // public.users share the same public.users.email" — the identifier said
  // twice reads as boilerplate, and boilerplate is what an eye skips. This
  // sentence is the one control standing in door ③; it has to be read.
  const sentence = t(lang, `rule.will-check.${rule.check!}` as MessageKey, {
    table: rule.table!,
    columns: listOf(rule.columns, lang),
    target: rule.references ?? '',
  });

  // The clause that says what "empty" counts, appended rather than folded in:
  // the first sentence names the target, the second narrows the word. A reader
  // skimming still meets the identifiers; a reader deciding gets the meaning.
  if (rule.check === 'is-never-missing' && admission !== null) {
    return `${sentence} ${missingMeaningSentence(admission, lang)}`;
  }
  return sentence;
}

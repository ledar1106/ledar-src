/**
 * The shapes every finding has to fit.
 *
 * A shape is checked by the compiler, and the compiler is not in the room
 * when a finding arrives as JSON out of the history store or as text from a
 * model. So these schemas are the source of the types *and* the thing that
 * runs: `sealFindings` in `seal.ts` parses against them at the boundary of
 * every pack, and a finding that has not been through it cannot be returned.
 *
 * Anything declared here that a user could be misled by carries its own
 * explanation, because the person reading the refusal is the person who has
 * to fix it.
 */

import { z } from 'zod';

/**
 * A string that has to actually say something.
 *
 * `.min(1)` lets `"   "` through, and a whitespace boundary is a missing
 * boundary that passes validation — the worst of both.
 */
function saying(what: string): z.ZodEffects<z.ZodString, string, string> {
  return z
    .string()
    .refine((s) => s.trim().length > 0, { message: `${what} is empty` });
}

/**
 * How much weight a statement carries.
 *
 * The distinction is the product's name, not a nicety. `observation` is
 * something the database asserts and a query can reproduce. `inference` is a
 * pattern that was noticed, which may turn out to be intentional. Calling the
 * second one a bug before its intent is confirmed is the failure this type
 * exists to prevent.
 *
 * `negative` and `abstained` are the same distinction pointed the other way,
 * and debt N8 is the gap between them. *I looked at 40 things and none of them
 * was wrong* is a RESULT. *I could not look at any of the 40* is the ABSENCE
 * of a result. Both used to serialise as `negative`, and anything grouping by
 * `kind` — a report, a model, a spreadsheet, next month's diff — read the
 * second one as a clean bill.
 *
 * The prose already said the right thing; the machine-readable field did not,
 * and the field is what travels. This is F.4 — *abstain is not a pass* —
 * turned into something `sealFindings` refuses rather than something an author
 * has to remember.
 *
 * A denominator of zero is NOT an abstention. "This database has no
 * unvalidated constraints" is a fact read out of the catalog, and the rule
 * that reports it looked at everything there was to look at.
 */
export const ClaimKind = z.enum([
  'observation',
  'inference',
  'recommendation',
  'negative',
  'abstained',
]);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const Confidence = z.enum(['certain', 'probable', 'unconfirmed']);
export type Confidence = z.infer<typeof Confidence>;

/**
 * How this claim came to exist — the question `kind` does not answer.
 *
 * `_doc/05` §7 asks for this, and gives the reason: with four claim kinds and
 * nothing else, a Layer B guess and a Layer A count serialise into the same
 * shape, and whatever reads them next — a report, a model, somebody's
 * spreadsheet — has no way to tell them apart. `kind` says how much weight the
 * sentence carries. `origin` says where the weight came from.
 *
 *   catalog         read out of pg_catalog. No user row was touched.
 *   counted         every matching row was counted, up to a stated ceiling.
 *   sampled         a bounded sample was measured; the rest is arithmetic.
 *   name_pattern    proposed because two names looked alike, before any
 *                   value was compared. On its own this is a guess.
 *   user_declared   the person who owns the system said so.
 *   user_confirmed  they agreed with something this found.
 *   model_written   a language model produced the wording. Never the finding.
 */
export const ClaimOrigin = z.enum([
  'catalog',
  'counted',
  'sampled',
  'name_pattern',
  'user_declared',
  'user_confirmed',
  'model_written',
]);
export type ClaimOrigin = z.infer<typeof ClaimOrigin>;

/**
 * What the confidence rests on, so it can be argued with.
 *
 * `confidence: 'certain'` asserts. This says *why*, which is the part a
 * reader can check. It also lets `sealFindings` refuse a certainty that no
 * basis supports — a rule cannot be sure because it feels sure.
 */
export const ConfidenceBasis = z.enum([
  'database_constraint',
  'full_count',
  'sample_extrapolation',
  'name_similarity',
  'user_statement',
  'model_output',
]);
export type ConfidenceBasis = z.infer<typeof ConfidenceBasis>;

/**
 * Whether the person who owns the system has had their say.
 *
 * Only `unreviewed` can be produced honestly today — nothing in the product
 * asks the question yet. It is here anyway, and required, because the absence
 * of an answer is a fact about the claim: a Layer B pattern nobody has ruled
 * on is not the same object as one the owner called intentional, and the two
 * must not be able to look alike the day the asking exists.
 */
export const UserStatus = z.enum([
  'unreviewed',
  'confirmed',
  'rejected',
  'intentional',
]);
export type UserStatus = z.infer<typeof UserStatus>;

/**
 * How far this claim is allowed to travel.
 *
 * From `_doc/05` §7: *"an Evidence Pack sent through a managed proxy is still
 * customer data even with no raw row in it."* That is why this vocabulary
 * exists instead of a boolean called `redacted` — a pack is not anonymous, it
 * is customer data of a particular class, and the class is written on the box.
 *
 * Maps onto the two lists in `_doc/16` §2:
 *
 *   never-leaves              row values, connection strings, sample contents
 *   customer-system-metadata  schema identifiers, counts, shapes, timestamps
 *   product-constant          sentences LEDAR itself wrote
 */
export const EgressClass = z.enum([
  'never-leaves',
  'customer-system-metadata',
  'product-constant',
]);
export type EgressClass = z.infer<typeof EgressClass>;

/** The values, for callers that need to iterate rather than validate. */
export const EGRESS_CLASSES = EgressClass.options;

export const Severity = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type Severity = z.infer<typeof Severity>;

/**
 * What the scanner could and could not see.
 *
 * Two denominators, deliberately. `visibleTables` is what the granted role
 * can see; `totalTables` is how many exist. They are usually different, and a
 * report that quotes only the first is telling the user their whole system
 * was checked when it was not.
 *
 * `totalTables` is null when nobody has told us — which is itself worth
 * printing, rather than quietly assuming the two are equal.
 */
export const ScopeManifest = z.object({
  database: z.string(),
  role: z.string(),
  schemas: z.array(z.string()),
  visibleTables: z.number().int().nonnegative(),
  totalTables: z.number().int().nonnegative().nullable(),
  grantedAt: z.string().nullable(),
  readOnlyEnforcedByDatabase: z.boolean(),
  /** Present whenever the connection could still write. */
  disclosure: z.string().nullable(),
});
export type ScopeManifest = z.infer<typeof ScopeManifest>;

/**
 * What was actually examined for one rule.
 *
 * `checked` and `skipped` are recorded per rule rather than globally, because
 * "we looked at 39 tables" means nothing if this particular rule only applies
 * to 4 of them.
 */
export const Coverage = z.object({
  /** The numerator: how many eligible targets were actually examined. */
  checked: z.number().int().nonnegative(),

  /**
   * The denominator: how many targets this rule applied to at all.
   *
   * Nullable, and that is the point. `0` means "there was nothing to check".
   * A rule that cannot work out its own denominator has to say `null` — if
   * the only way to express not knowing is to write `0`, then not knowing
   * gets reported as a clean result. That substitution is not hypothetical
   * here: `GREATEST(reltuples, 0)` in the database qualifier turned "nobody
   * has ever run ANALYZE on this table" into "this table has 0 rows".
   *
   * A negative claim with a null denominator is refused by `sealFindings`.
   * "I found nothing" is only worth reading beside "out of how many".
   */
  eligible: z.number().int().nonnegative().nullable(),

  /**
   * Targets that were NOT examined, each with a reason a person can read.
   *
   * Not an error channel. A target the rule looked at and then dismissed was
   * checked, not skipped; filing it here would overstate what was left out
   * and understate what was done.
   */
  skipped: z.array(z.object({ target: z.string(), reason: z.string() })),

  /** Set when a limit stopped the check early. Silent truncation is a lie. */
  truncatedAt: z.number().int().positive().nullable(),

  // ---- the split `_doc/05` asks for -------------------------------------
  //
  // Four refinements, every one of them NULLABLE, and the nullability is the
  // whole design. `checked` and `eligible` above are the pair every rule has
  // always been able to state. These four are the pair pulled apart, and a
  // rule that cannot honestly separate them says null rather than filling in
  // a number that looks like a measurement.
  //
  // That is the same rule `eligible` already follows and for the same reason:
  // if the only way to express not knowing is to write 0, then not knowing
  // gets read as a clean result. `GREATEST(reltuples, 0)` turned "nobody has
  // run ANALYZE" into "this table has 0 rows" once already.

  /**
   * Targets of this rule's kind that the granted role could see at all.
   *
   * The outermost denominator, and the one a role's privileges decide. It sits
   * above `eligible` because a rule can be inapplicable to something the role
   * can see perfectly well — an index on a table with no uniqueness rule is
   * visible and not eligible — and the gap between the two numbers is the
   * difference between *not my business* and *not allowed to look*.
   */
  visibleToRole: z.number().int().nonnegative().nullable(),

  /**
   * Of `checked`, how many were read in full.
   *
   * "Read in full" means every row that could carry the answer was counted.
   * A verified target that came back clean is clean.
   */
  verified: z.number().int().nonnegative().nullable(),

  /**
   * Of `checked`, how many were answered from a sample.
   *
   * Kept apart from `verified` because silence about a sampled target is not
   * the same claim. Layer B already says this in prose — *"broken links rarer
   * than roughly 0.03% of a table can be missed entirely by a sample that
   * size"* — and until now the number behind that sentence was nowhere in the
   * record, so a later diff could not tell a clean full read from a clean
   * sample.
   */
  sampled: z.number().int().nonnegative().nullable(),

  /**
   * Targets deliberately set aside, with a reason, having been looked at.
   *
   * Not the same as `skipped`. Something in `skipped` was never examined;
   * something excluded was examined and then ruled out. Reporting the second
   * as the first overstates what was left undone, and the two lead a reader
   * to opposite conclusions about whether to go and look themselves.
   */
  excluded: z.number().int().nonnegative().nullable(),
})
  .superRefine((c, ctx) => {
    // The arithmetic, checked here rather than trusted, on the same principle
    // as `assertStripAddsUp`: a coverage record that cannot add up is one no
    // diff should be built on, and a `Coverage` can arrive from a history
    // file, a future front end, or a hand-written literal in a test.
    //
    // Only checked when BOTH halves were stated. A rule that says nothing is
    // not making a claim that can be wrong.
    if (c.verified !== null && c.sampled !== null && c.verified + c.sampled !== c.checked) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verified'],
        message:
          `verified (${c.verified}) + sampled (${c.sampled}) is ` +
          `${c.verified + c.sampled}, but checked says ${c.checked}. Every ` +
          `target that was checked took exactly one of the two routes, so ` +
          `these cannot all be true at once.`,
      });
    }

    // `excluded` is a subset of `checked`, not a sibling of it. Layer B says
    // so in its own docstring — *"these were checked; they are already inside
    // candidatesVerified"* — and the definition here agrees: something
    // excluded was looked at and then set aside, which is a thing that
    // happened to a target that was checked.
    if (c.excluded !== null && c.excluded > c.checked) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['excluded'],
        message:
          `excluded (${c.excluded}) is above checked (${c.checked}). A target ` +
          `set aside was looked at first, so it cannot be excluded without ` +
          `having been checked — one of these two was counted over a ` +
          `population the other was not.`,
      });
    }

    if (
      c.visibleToRole !== null &&
      c.eligible !== null &&
      c.visibleToRole < c.eligible
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['visibleToRole'],
        message:
          `visibleToRole (${c.visibleToRole}) is below eligible ` +
          `(${c.eligible}). A rule cannot apply to more targets than the role ` +
          `can see; if it looks that way, one of the two was counted over a ` +
          `different population than the other.`,
      });
    }
  });
export type Coverage = z.infer<typeof Coverage>;

/**
 * A coverage record with only the pair every rule has always stated.
 *
 * The four refinements set to null, which is what they mean: *this rule did
 * not separate these*. Used by call sites that build a `Coverage` by hand and
 * have nothing more honest to say, so that adding the fields did not turn into
 * four zeroes appearing across the codebase — and a zero here is a claim.
 */
export function coverageOf(
  checked: number,
  eligible: number | null,
  skipped: readonly { target: string; reason: string }[] = [],
  truncatedAt: number | null = null,
): Coverage {
  return {
    checked,
    eligible,
    skipped: [...skipped],
    truncatedAt,
    visibleToRole: null,
    verified: null,
    sampled: null,
    excluded: null,
  };
}

/** The query that produced a number, kept so the number can be re-derived. */
export const Evidence = z.object({
  sql: z.string(),
  rowCount: z.number().int().nonnegative(),

  /**
   * How many rows were looked at to arrive at `rowCount`.
   *
   * The denominator, and only the denominator. `rowCount` of 5 means one
   * thing beside a `sampleSize` of 25 and another beside a `sampleSize` of
   * 25,000, and the sentence a user reads — "5 of the 25 rows" — is built
   * from exactly this pair.
   *
   * `null` when `rowCount` is a straight count rather than an estimate off a
   * sample. Layer A counts every offending row up to its ceiling, so it has
   * no sample denominator and says so.
   *
   * Not the number of example rows kept: that is `sample.length`, it is
   * sitting right there, and it never needed a second field. Layer A used to
   * write it here — one field carrying two meanings, undeclared, in a
   * structure that leaves the machine inside an Evidence Pack. The same
   * shape as the three redactors that agreed until they did not.
   */
  sampleSize: z.number().int().nonnegative().nullable(),

  durationMs: z.number().nonnegative(),
  /** Redacted sample rows. Never raw values. */
  sample: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
});
export type Evidence = z.infer<typeof Evidence>;

const FindingBase = z.object({
  id: z.string(),
  rule: z.string(),
  kind: ClaimKind,
  confidence: Confidence,
  severity: Severity,

  // ---- provenance ---------------------------------------------------------
  //
  // `_doc/05` §7 asks for these on every claim rather than on the run, and the
  // reason is what happens to a claim that travels alone: into a report, into
  // a model's prompt, into a proxy. Everything the run knew about it — how it
  // was measured, when, by which version of which rule — stays behind unless
  // the claim carries it.
  //
  // They are not decoration. `sealFindings` reads them: a `certain` claim whose
  // basis is a name similarity is refused, which turns "Layer B may not speak
  // with certainty" from a sentence in AGENTS.md into something a machine
  // checks.

  /** Where this came from. See `ClaimOrigin`. */
  origin: ClaimOrigin,

  /** What the confidence rests on. See `ConfidenceBasis`. */
  confidenceBasis: ConfidenceBasis,

  /** How far it may travel. See `EgressClass`. */
  egressClass: EgressClass,

  /**
   * When this particular claim was measured, ISO 8601.
   *
   * Per claim, not per run: a scan of 374 tables takes half a minute, and a
   * count taken at the start and one taken at the end are statements about two
   * different databases if somebody was writing to it meanwhile.
   */
  observedAt: z.string().min(1),

  /**
   * Which version of the rule produced this.
   *
   * The store can already tell a data change from a verdict change. It cannot
   * tell either of those from *the rule having been rewritten between
   * releases*, and without this it never will: every finding would read as
   * changed, or none would, depending on which fields the rewrite touched.
   */
  engineRuleVersion: z.string().min(1),

  /** Whether the system's owner has ruled on it. Defaults to `unreviewed`. */
  userStatus: UserStatus.default('unreviewed'),
  schema: z.string(),
  table: z.string(),
  columns: z.array(z.string()).default([]),

  /**
   * What this means for someone who does not read schemas — consequence
   * first, numbers second, mechanism last.
   *
   * Required, because a finding nobody can act on is not a finding.
   */
  plainText: saying('plainText'),

  /** The same thing said in the vocabulary of whoever has to fix it. */
  technical: saying('technical'),

  evidence: Evidence.nullable(),
  coverage: Coverage,
});

/**
 * Anything asserting that something is *not* wrong must state where it
 * looked.
 *
 * The compiler enforces this for findings it can see. `sealFindings` enforces
 * it for the rest — findings read back out of the store, or produced by
 * anything that was not compiled against this file.
 */
export const Finding = z.discriminatedUnion('kind', [
  FindingBase.extend({ kind: z.literal('observation') }),
  FindingBase.extend({ kind: z.literal('inference') }),
  FindingBase.extend({ kind: z.literal('recommendation') }),
  FindingBase.extend({
    kind: z.literal('negative'),
    /** The sentence that makes "nothing found" honest. */
    boundary: saying('boundary'),
  }),
  FindingBase.extend({
    kind: z.literal('abstained'),
    /**
     * Here the boundary is not a caveat on the claim — it IS the claim.
     * An abstention has nothing else to say: no rows were counted, no
     * targets were reached, and the only content is which ones and why.
     */
    boundary: saying('boundary'),
  }),
]);
export type Finding = z.infer<typeof Finding>;

export const ScanResult = z.object({
  startedAt: z.string(),
  finishedAt: z.string(),
  scope: ScopeManifest,
  findings: z.array(Finding),
});
export type ScanResult = z.infer<typeof ScanResult>;

/**
 * Layer B findings are hypotheses until their intent is confirmed, so the
 * words that assert a defect are not available to them.
 *
 * "Until confirmed" means two things, and the gate below reads both: the
 * claim is not `certain`, and the owner has not marked it `confirmed`. Either
 * one alone lets something through — a `probable` claim escapes a test on
 * `unconfirmed`, and a claim the owner HAS ruled on should be allowed to say
 * what it is.
 */
const FORBIDDEN_IN_UNCONFIRMED = /\b(bug|broken|error|wrong|invalid|corrupt|failure)\b/i;

/**
 * The same ban, in the other language this product speaks.
 *
 * 🟥 Found 2026-08-24, and it had been open since the day `LEDAR_LANG=vi`
 * shipped. The list above is English-only, so from the moment the report could
 * be rendered in Vietnamese, **hard rule ③ was enforced on half of it.** The
 * Vietnamese catalogue kept the rule anyway — its own header records the
 * decision *"KHÔNG dùng 'lỗi' cho phát hiện Tầng B"* — but kept it BY HAND,
 * which is a promise in a comment, and this codebase already knows what those
 * are worth.
 *
 * It stayed harmless only because every Vietnamese sentence in the product was
 * written by a person who had read that header. It stops being harmless the
 * moment a model writes Vietnamese into a report, which is precisely what
 * VS-8 is for — so the fence goes up before the thing it fences exists.
 *
 * This is `AGENTS.md` §4.9 ① a third time: *a gate that reads one language
 * guards half a report*. Written down twice already, and still missed here,
 * because the gate was written when there was only one language to read.
 *
 * ## Why these words and not the obvious ones
 *
 * `hư` is NOT here, and that is the interesting exclusion. It means broken —
 * and `hư không` means *nothingness*, which is exactly what the Vietnamese
 * catalogue says in `layer-b.aside.one-repeated-value`: links that lead
 * `tới hư không`. That phrasing was itself the fix for an earlier version of
 * this same rule. A gate banning `hư` would have failed the sentence written
 * to satisfy it.
 *
 * `sai` alone is out for the same reason: `sai số` is *margin of error*, a
 * thing this product says about its own measurements constantly. `sai sót` —
 * a mistake — is unambiguous, so that is what is banned.
 *
 * ## 🟥 A trap for whoever extends this list
 *
 * **`` does not work after a Vietnamese vowel that carries a diacritic.**
 * JavaScript's `\w` is ASCII-only, so `ư`, `ố`, `ạ` are non-word characters.
 * `hư` has a non-word character on both sides of its trailing boundary and
 * therefore **never matches anything, ever** — it compiles, it reads correctly,
 * and it is dead.
 *
 * Every entry above ends on an ASCII letter (`i`, `g`, `t`) for exactly this
 * reason. A plausible addition like `sai số` would end on `ố` and join the
 * list as a rule that is never enforced.
 *
 * Not left to this comment: `set-aside.test.ts` asserts that every entry here
 * can actually fire. A word list where one entry is silently dead is worse
 * than a shorter list, because the count says the rule is covered.
 */
const FORBIDDEN_IN_UNCONFIRMED_VI = /(\blỗi\b|\bhỏng\b|\bhư hỏng\b|\bsai sót\b|\bbị lỗi\b)/i;

/**
 * The banned Vietnamese words as plain strings, for the test that proves each
 * one can still fire. Kept beside the regex so the two cannot drift apart.
 */
export const DEFECT_WORDS_VI = ['lỗi', 'hỏng', 'hư hỏng', 'sai sót', 'bị lỗi'] as const;

/**
 * The word ban, on any sentence that reaches a reader.
 *
 * Lifted out of `assertClaimDiscipline` when debt N42 found the second channel
 * into the report — `ruledOut` and `notExamined`, which are printed in the
 * product's voice and were read by no gate at all. A copy of the regex in
 * `set-aside.ts` would have been a second source of truth for the one rule
 * this product is least able to afford drifting on.
 *
 * `subject` is the clause that goes in front of the complaint, so the error
 * says which sentence and which rule, rather than only which word.
 */
export function assertNoDefectWords(text: string, subject: string): void {
  const hit =
    FORBIDDEN_IN_UNCONFIRMED.exec(text) ?? FORBIDDEN_IN_UNCONFIRMED_VI.exec(text);
  if (hit) {
    throw new Error(
      `${subject} but says "${hit[0]}". An observed pattern is not a defect ` +
        `until the person who owns the system says it was not intended.`,
    );
  }
}

/**
 * One clause of the gate, not the gate.
 *
 * Exported because it is worth reading on its own and worth testing on its
 * own. Rules should not call it directly: `sealFindings` runs it, alongside
 * the shape check and the coverage rules, and calling only this one is how
 * the other two got skipped for a while.
 */
export function assertClaimDiscipline(finding: Finding): void {
  // The condition used to be `confidence === 'unconfirmed'`, which is narrower
  // than the rule it implements — and narrower in a way nothing would have
  // shown.
  //
  // `sample_extrapolation` has a ceiling of `probable` (CEILING in seal.ts),
  // so a Layer B rule reading sampled rows may legitimately publish a
  // `probable` claim. At that moment the word ban stopped applying, silently.
  // No rule emits `probable` today — every Layer B finding on record is
  // `unconfirmed`, checked against the scan history and not assumed — so the
  // hole was latent rather than open. Latent is how a hole is still there
  // when somebody eventually walks into it.
  //
  // AGENTS.md §3 ③ says *chưa xác nhận*: not yet confirmed. The contract
  // already carries both halves of that. Anything below `certain` is Layer B
  // territory by the ceiling above, and `userStatus` is where the owner's
  // ruling is recorded. Once they have said a pattern was not intended, it IS
  // a defect and the words are theirs to use.
  if (finding.confidence !== 'certain' && finding.userStatus !== 'confirmed') {
    for (const text of [finding.plainText, finding.technical]) {
      assertNoDefectWords(
        text,
        `Finding ${finding.id} is not confirmed (confidence ` +
          `\`${finding.confidence}\`, the owner has not ruled on it)`,
      );
    }
  }

  if (finding.kind === 'observation' && finding.evidence === null) {
    throw new Error(
      `Finding ${finding.id} is an observation with no evidence. An ` +
        `observation is something a query can reproduce; without the query ` +
        `it is an inference.`,
    );
  }
}

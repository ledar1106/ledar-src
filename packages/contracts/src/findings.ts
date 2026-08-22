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
});
export type Coverage = z.infer<typeof Coverage>;

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
 */
const FORBIDDEN_IN_UNCONFIRMED = /\b(bug|broken|error|wrong|invalid|corrupt|failure)\b/i;

/**
 * One clause of the gate, not the gate.
 *
 * Exported because it is worth reading on its own and worth testing on its
 * own. Rules should not call it directly: `sealFindings` runs it, alongside
 * the shape check and the coverage rules, and calling only this one is how
 * the other two got skipped for a while.
 */
export function assertClaimDiscipline(finding: Finding): void {
  if (finding.confidence === 'unconfirmed') {
    for (const text of [finding.plainText, finding.technical]) {
      const hit = FORBIDDEN_IN_UNCONFIRMED.exec(text);
      if (hit) {
        throw new Error(
          `Finding ${finding.id} is unconfirmed but says "${hit[0]}". An ` +
            `observed pattern is not a defect until the person who owns the ` +
            `system says it was not intended.`,
        );
      }
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

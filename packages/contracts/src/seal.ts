/**
 * The one door a finding leaves through.
 *
 * `findings.ts` describes the shapes. It cannot enforce them: a shape is
 * checked by the compiler, and the compiler is not present when a finding
 * arrives as JSON out of the history store, or as text from a model. Until
 * this file existed the only run-time check was `assertClaimDiscipline`,
 * called by hand at five different call sites — a convention, which is
 * another word for something that holds until somebody is in a hurry.
 *
 * So the gate is not a function you are supposed to remember. It is the only
 * way to obtain the type a pack has to return:
 *
 *     export async function runLayerA(...): Promise<SealedFinding[]>
 *
 * `SealedFinding` carries a brand no object literal can satisfy, so a rule
 * that builds a finding and pushes it straight into the result array does not
 * compile. Going around the gate is still possible — `as unknown as
 * SealedFinding` will do it — but that is now a sentence somebody has to
 * write on purpose and another person can find, rather than a call somebody
 * forgot to add.
 *
 * What the gate refuses, and why each refusal exists, is in `problemWith`
 * below. Every refusal throws. See `ClaimRefused` for the reasoning.
 */

import { z } from 'zod';

import { assertClaimDiscipline, Finding, ScopeManifest } from './findings.js';
import type { ClaimOrigin, Confidence, ConfidenceBasis } from './findings.js';

declare const SEAL: unique symbol;

/**
 * A finding that has been through `sealFindings`.
 *
 * The brand exists only in the type system; at run time a sealed finding is
 * an ordinary object. Its job is to make the gate unavoidable rather than
 * merely available.
 */
export type SealedFinding = Finding & {
  readonly [SEAL]: 'checked at the pack boundary';
};

/**
 * What a rule builds before the gate has seen it.
 *
 * This is the schema's *input* type, so fields with defaults (`columns`,
 * `sample`) may be omitted. Typing a rule's working array as `FindingDraft[]`
 * keeps the compiler's help while leaving the run-time check in charge.
 */
export type FindingDraft = z.input<typeof Finding>;

/**
 * Thrown when a finding is not fit to publish.
 *
 * It throws rather than dropping the finding and noting it in `skipped`,
 * which was the other candidate. `skipped` means *"this target was not
 * examined, here is the reason"* — it is a coverage statement shown to the
 * user. A finding that was examined and then failed validation is not a gap
 * in coverage; filing it there would make the coverage report itself untrue,
 * and would turn a defect in a rule into a line of prose the reader has no
 * way to distinguish from a table that was too big to scan.
 *
 * The failure mode this project keeps hitting is a defensive default turning
 * BROKEN into EMPTY. Silently dropping the one finding that did not validate
 * is that failure mode exactly: the scan still prints, the report still looks
 * clean, and the thing that went wrong is the thing nobody sees.
 */
export class ClaimRefused extends Error {
  readonly producer: string;
  readonly findingId: string | null;
  /** Position in the batch, for findings that do not have an id yet. */
  readonly index: number;

  constructor(
    message: string,
    producer: string,
    findingId: string | null,
    index: number,
  ) {
    super(message);
    this.name = 'ClaimRefused';
    this.producer = producer;
    this.findingId = findingId;
    this.index = index;
  }
}

/**
 * Why a given field matters, said to the person who has to fix it.
 *
 * Zod's own message ("Required") names the field and stops. The reader of
 * this message is a rule author who is about to decide whether the rule or
 * the gate is wrong, and that decision needs the reason.
 */
const WHY: Record<string, string> = {
  boundary:
    'A negative claim states that something was not found. Without a\n' +
    'boundary it reads as "there is nothing to find", which is a much\n' +
    'larger statement than the one that was measured.\n\n' +
    'Add `boundary`: one sentence naming what was examined and what was\n' +
    'not — "checked 12 of 14 constraints in public; 2 were skipped, and\n' +
    'nothing here covers rules that were never declared."',

  kind:
    '`kind` decides how much weight a sentence carries and which extra\n' +
    'fields are required of it. It has to be one of: observation,\n' +
    'inference, recommendation, negative.',

  plainText:
    'Every finding has to be readable by the person who is accountable\n' +
    'for the database, not only by the person who built it. A finding\n' +
    'nobody can act on is not a finding.',

  technical:
    'The same statement has to exist in the vocabulary of whoever will\n' +
    'have to fix it, or the plain-language version cannot be checked\n' +
    'against anything.',

  'coverage.eligible':
    '`eligible` is the denominator: how many targets this rule applied\n' +
    'to. It may be null when the rule genuinely does not know — but do\n' +
    'not write 0 to mean "unknown". 0 means "there was nothing to\n' +
    'check", and a reader cannot tell the two apart.',

  'coverage.checked':
    '`checked` is the numerator: how many of the eligible targets this\n' +
    'rule actually examined.',
};

function whyFor(path: string): string {
  const exact = WHY[path];
  if (exact) return exact;
  const leaf = path.split('.').pop() ?? path;
  return (
    WHY[leaf] ??
    'This field is part of the shape every finding has to fit. See\n' +
      'packages/contracts/src/findings.ts for what it is for.'
  );
}

function indent(text: string, by = '  '): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? by + line : line))
    .join('\n');
}

function readString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

function refuse(ctx: {
  producer: string;
  index: number;
  id: string | null;
  rule: string | null;
  problem: string;
  why: string;
}): ClaimRefused {
  const where = ctx.id ?? `finding #${ctx.index + 1}, which has no id`;
  const rule = ctx.rule ? `\n  rule:    ${ctx.rule}` : '';

  const message =
    `${ctx.producer} tried to publish a finding that does not hold up.\n\n` +
    `  finding: ${where}${rule}\n` +
    `  problem: ${ctx.problem}\n\n` +
    `${indent(ctx.why)}\n\n` +
    `  Nothing from ${ctx.producer} was published. The scan stopped rather\n` +
    `  than printing a report with a hole in it that nobody could see.`;

  return new ClaimRefused(message, ctx.producer, ctx.id, ctx.index);
}

function pathOf(issue: z.ZodIssue): string {
  return issue.path.length > 0 ? issue.path.join('.') : 'the finding itself';
}

/**
 * Turns a Zod failure into one sentence about what went wrong.
 *
 * Only the first issue is reported. A finding with six issues is a finding
 * nobody has looked at yet, and six paragraphs would bury the first one.
 */
function shapeProblem(error: z.ZodError): { problem: string; why: string } {
  const issue = error.issues[0];
  if (!issue) {
    return { problem: 'it does not match the Finding shape', why: whyFor('') };
  }

  const path = pathOf(issue);

  if (issue.code === 'invalid_union_discriminator') {
    return {
      problem: `\`kind\` is not one of the four claim kinds`,
      why: WHY.kind!,
    };
  }

  if (
    issue.code === 'invalid_type' &&
    (issue as z.ZodInvalidTypeIssue).received === 'undefined'
  ) {
    return { problem: `\`${path}\` is missing`, why: whyFor(path) };
  }

  return {
    problem: `\`${path}\` — ${issue.message}`,
    why: whyFor(path),
  };
}

/**
 * The coverage rules a shape cannot express.
 *
 * Zod can insist that `checked` and `eligible` are both present. It cannot
 * insist that the fraction they form is one a person could have arrived at,
 * and an incoherent fraction is worse than a missing one: it reads as a
 * measurement.
 */
function coverageProblem(f: Finding): { problem: string; why: string } | null {
  const c = f.coverage;

  if (c.eligible !== null) {
    if (c.checked > c.eligible) {
      return {
        problem: `coverage says ${c.checked} checked out of ${c.eligible} eligible`,
        why:
          'A numerator larger than its denominator is not a measurement of\n' +
          'anything. Either more targets were eligible than the rule\n' +
          'counted, or fewer were checked than it thinks.',
      };
    }

    if (c.checked + c.skipped.length > c.eligible) {
      return {
        problem:
          `coverage says ${c.checked} checked and ${c.skipped.length} skipped, ` +
          `out of ${c.eligible} eligible`,
        why:
          '`skipped` lists targets that were NOT examined. Checked plus\n' +
          'skipped therefore cannot exceed the number that were eligible.\n' +
          'If the rule examined something and then dismissed it, that is a\n' +
          'checked target, not a skipped one.',
      };
    }
  }

  // Debt N8 / F.4. `negative` claims to have looked; `abstained` claims not
  // to have. Neither is allowed to wear the other's name, and the numbers are
  // right there to check it against.
  if (f.kind === 'negative' && c.eligible !== null && c.eligible > 0 && c.checked === 0) {
    return {
      problem: `a negative claim that checked 0 of ${c.eligible} eligible targets`,
      why:
        '"I looked and found nothing" and "I could not look" are different\n' +
        'statements, and only the first is a result. A rule that reached\n' +
        'none of its targets has abstained; say so with `kind: "abstained"`\n' +
        'so that everything downstream — a report, a model, next month\'s\n' +
        'diff — cannot read the silence as a clean bill.',
    };
  }

  if (f.kind === 'abstained' && (c.eligible === null || c.eligible === 0)) {
    return {
      problem: 'an abstention with nothing to abstain from',
      why:
        'Abstaining means there was something to check and it was not\n' +
        'checked. With no eligible targets there was nothing to reach, and\n' +
        '"this database has none of these" is a result — a negative one.',
    };
  }

  if (f.kind === 'abstained' && c.checked > 0) {
    return {
      problem: `an abstention that checked ${c.checked} of ${c.eligible} targets`,
      why:
        'Something was checked, so this is not an abstention. Reporting\n' +
        'partial work as no work understates the scan in the one direction\n' +
        'nobody audits — the direction that looks modest.',
    };
  }

  if (f.kind === 'negative' && c.eligible === null) {
    return {
      problem: 'a negative claim whose denominator is unknown',
      why:
        '"I did not find anything" is only worth reading next to "out of\n' +
        'how many". A negative claim that cannot say how many targets it\n' +
        'applied to is not a result — it is the absence of one, and the\n' +
        'two look identical on a screen.',
    };
  }

  return null;
}

/**
 * Which basis each origin is entitled to claim.
 *
 * A rule that read pg_catalog cannot say its confidence rests on a full count,
 * and one that matched two names cannot say a constraint told it. The pairing
 * is not a formality: `origin` and `confidenceBasis` are the two halves of the
 * same sentence, and a claim whose halves disagree is one nobody checked.
 */
const BASIS_FOR_ORIGIN: Record<ClaimOrigin, ConfidenceBasis> = {
  catalog: 'database_constraint',
  counted: 'full_count',
  sampled: 'sample_extrapolation',
  name_pattern: 'name_similarity',
  user_declared: 'user_statement',
  user_confirmed: 'user_statement',
  model_written: 'model_output',
};

/**
 * The most a given basis is allowed to assert.
 *
 * This is AGENTS.md §3 rule ③ — *Layer B may not use the word "error" until
 * its intent is confirmed* — expressed as something a machine can refuse
 * rather than something an author has to remember. A count of rows Postgres
 * itself constrains can be certain. Two names that look alike cannot be, no
 * matter how convincing the sentence around it reads.
 */
const CEILING: Record<ConfidenceBasis, Confidence> = {
  database_constraint: 'certain',
  full_count: 'certain',
  sample_extrapolation: 'probable',
  name_similarity: 'unconfirmed',
  user_statement: 'probable',
  model_output: 'unconfirmed',
};

const RANK: Record<Confidence, number> = { unconfirmed: 0, probable: 1, certain: 2 };

/**
 * A moment, not a day.
 *
 * This gate used to ask only whether `Date.parse` understood the string, which
 * let `'2026-08-21'` through — while the export gate in `evidence-pack.ts`
 * refused the same value. Two gates, one field, different answers: a finding
 * could be published locally and then refused on its way out of the machine.
 *
 * The pattern is deliberately identical to `ISO_TIMESTAMP` there. Two copies
 * again, and this one is not forced — but the alternative was for `seal.ts` to
 * import from `evidence-pack.ts`, which reverses the dependency: the pack is
 * built out of sealed findings, so it knows about the gate and not the other
 * way round. `packages/contracts/test/seal.test.ts` asserts the two agree.
 */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** Provenance rules a shape cannot express. */
function provenanceProblem(f: Finding): { problem: string; why: string } | null {
  const expected = BASIS_FOR_ORIGIN[f.origin];
  if (f.confidenceBasis !== expected) {
    return {
      problem:
        `origin \`${f.origin}\` with confidenceBasis ` +
        `\`${f.confidenceBasis}\``,
      why:
        `A claim that came from \`${f.origin}\` rests on ` +
        `\`${expected}\`, not on \`${f.confidenceBasis}\`. These two\n` +
        `fields are halves of one sentence — where the claim came from,\n` +
        `and what its confidence stands on. Halves that disagree mean\n` +
        `nobody read them together.`,
    };
  }

  const ceiling = CEILING[f.confidenceBasis];
  if (RANK[f.confidence] > RANK[ceiling]) {
    return {
      problem: `confidence \`${f.confidence}\` on \`${f.confidenceBasis}\``,
      why:
        `\`${f.confidenceBasis}\` supports at most \`${ceiling}\`.\n\n` +
        `This is the rule in AGENTS.md §3 ③ with a machine behind it: a\n` +
        `pattern is not a defect until the person who owns the system says\n` +
        `it was not intended, and no amount of confident wording makes two\n` +
        `similar names into a fact. If this claim really is certain, it\n` +
        `came from somewhere else — say where, and the basis follows.`,
    };
  }

  if (!ISO_TIMESTAMP.test(f.observedAt)) {
    return {
      problem: `observedAt is not a timestamp: ${f.observedAt}`,
      why:
        `A count is a statement about a database at a moment. A scan takes\n` +
        `long enough for the database to change underneath it, so the moment\n` +
        `belongs to the claim rather than to the run that carried it.\n\n` +
        `A date on its own is not that moment. It is the moment thrown away\n` +
        `and the field kept, which is worse than an empty field because it\n` +
        `looks answered.`,
    };
  }

  return null;
}

/**
 * Checks a batch of findings and hands back the only type a pack may return.
 *
 * Every finding is parsed (so anything arriving untyped — store JSON, model
 * output — is held to the same shape as something the compiler saw), then
 * put through the claim-discipline rules, then through the coverage rules.
 * The first failure stops the batch.
 *
 * @param drafts   what the rule built. `unknown` on purpose: the point is to
 *                 accept input the compiler never saw. Rules that want the
 *                 compiler's help should type their own array `FindingDraft[]`.
 * @param producer which pack is publishing, named in any refusal.
 */
export function sealFindings(
  drafts: Iterable<unknown>,
  producer: string,
): SealedFinding[] {
  const sealed: SealedFinding[] = [];
  let index = -1;

  for (const draft of drafts) {
    index += 1;
    const id = readString(draft, 'id');
    const rule = readString(draft, 'rule');

    const parsed = Finding.safeParse(draft);
    if (!parsed.success) {
      const { problem, why } = shapeProblem(parsed.error);
      throw refuse({ producer, index, id, rule, problem, why });
    }

    const finding = parsed.data;

    try {
      assertClaimDiscipline(finding);
    } catch (err) {
      throw refuse({
        producer,
        index,
        id,
        rule,
        problem: 'the claim says more than it measured',
        why: err instanceof Error ? err.message : String(err),
      });
    }

    const coverage = coverageProblem(finding);
    if (coverage) {
      throw refuse({ producer, index, id, rule, ...coverage });
    }

    const provenance = provenanceProblem(finding);
    if (provenance) {
      throw refuse({ producer, index, id, rule, ...provenance });
    }

    sealed.push(finding as SealedFinding);
  }

  return sealed;
}

/**
 * The same gate for a single finding.
 *
 * Convenience for tests and for callers holding one finding. It is the batch
 * gate underneath, so there is no second set of rules to drift out of step.
 */
export function sealFinding(draft: unknown, producer: string): SealedFinding {
  const [only] = sealFindings([draft], producer);
  // sealFindings either returns one element or throws; this is for the type.
  if (!only) throw new Error('sealFindings returned nothing for one draft.');
  return only;
}

/**
 * Checks a scope manifest before anything is said in its name.
 *
 * The two denominators are the reason this type exists, and a manifest can
 * carry a pair of numbers that cannot both be true. It can also carry a
 * connection that is only read-only by promise, with nothing saying so.
 */
export function assertScopeManifest(input: unknown): ScopeManifest {
  const parsed = ScopeManifest.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Scope manifest is not usable: ` +
        `${issue ? `${pathOf(issue)} — ${issue.message}` : 'wrong shape'}. ` +
        `Nothing can be reported without knowing what was in scope.`,
    );
  }

  const s = parsed.data;

  if (s.totalTables !== null && s.totalTables < s.visibleTables) {
    throw new Error(
      `Scope manifest says ${s.visibleTables} tables were visible out of ` +
        `${s.totalTables} that exist. Both cannot be true. A visible table ` +
        `is one that exists.`,
    );
  }

  if (!s.readOnlyEnforcedByDatabase && s.disclosure === null) {
    throw new Error(
      `Scope manifest says the database is not enforcing read-only, but ` +
        `carries no disclosure. When the promise is made by this software ` +
        `rather than by Postgres, every report has to say so — otherwise ` +
        `the user is trusting a guarantee nobody made.`,
    );
  }

  return s;
}

/**
 * The two denominators, said out loud — including when the second is unknown.
 *
 * `totalTables === null` renders as not knowing. It is never quietly filled
 * in from `visibleTables`: that substitution is how "nobody has ever run
 * ANALYZE on this table" became "this table has 0 rows" in the database
 * qualifier, and how "47 of 47 tables" comes to mean nothing at all.
 */
export function scopeCoverageSentence(scope: ScopeManifest): string {
  const visible = scope.visibleTables;
  const total = scope.totalTables;

  if (total === null) {
    return (
      `${visible} table${visible === 1 ? '' : 's'} here could be read. How ` +
      `many exist in total, I do not know — nothing told me, and I am not ` +
      `going to assume the two numbers are the same.`
    );
  }

  if (total === visible) {
    return (
      `${visible} of ${total} table${total === 1 ? '' : 's'} could be read — ` +
      `all of them.`
    );
  }

  // "were not looked at", not "cannot be read".
  //
  // This function knows two numbers and nothing else. The gap between them
  // holds two different populations: tables the account genuinely has no
  // privilege on, and tables it could read perfectly well that simply sit in
  // schemas nobody pointed the scan at. Measured on one real database the
  // split was 39 and 2 — so "cannot read" was false about two of them.
  //
  // Saying why a table was left out is a claim about cause, and cause is not
  // one of the two numbers here. Whoever holds the breakdown can print it;
  // this sentence states only what it measured.
  const unexamined = total - visible;
  return (
    `${visible} of ${total} tables could be read. ${unexamined} more ` +
    `exist${unexamined === 1 ? 's' : ''} in this database that ` +
    `${unexamined === 1 ? 'was' : 'were'} not looked at; nothing said here ` +
    `covers ${unexamined === 1 ? 'it' : 'them'}.`
  );
}

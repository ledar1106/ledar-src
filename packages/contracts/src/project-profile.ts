/**
 * What this product knows about a system, and how sure it is of each part.
 *
 * This is ideal §23 (Project Profile) built on ideal §22 (the knowledge
 * ladder), fed by ideal §13–§18 (the fixed question set). It replaces the
 * one free-text question the shell shipped on 2026-08-27, and the reason it
 * replaces it is worth stating once here rather than in a commit nobody
 * re-reads.
 *
 * ## What the questions are FOR
 *
 * Not to author a rule. To collect the same few facts from a thousand people
 * in the same shape, so the product can build a MAP and answer later questions
 * from it instead of re-reading everything each time. The Licensor put it
 * plainly: you cannot hand an AI a whole codebase and wait — it is slow, and
 * when it finishes it still does not know what the data is doing.
 *
 * ## Two things the shipped interview got wrong, both fixed by this shape
 *
 * ```text
 * ① asked for KNOWLEDGE     "what does a customer expect after an ORDER"
 *                           → 2 of 6 unanswerable for the first real person,
 *                             because both assumed they sell things
 *    asks for RECOGNITION   "does this system have user login?"
 *                           → nobody has to understand a backend to answer
 *
 * ② one free-text box       a model had to read a sentence and turn it into
 *                           a check. That is the strongest invitation to obey
 *                           in the whole product, and it measured 0-1/5.
 *    a closed question set  no model on this path at all. Nothing to inject
 *                           into, nothing to misread.
 * ```
 *
 * ## Why every state carries its own evidence
 *
 * A profile is a set of claims about somebody's system, and this product does
 * not make claims it cannot back — the same rule `Finding` lives under. So the
 * ladder is not four names on an enum: each rung carries what earns it, and
 * the compiler refuses a rung whose backing is missing. `Verified` cannot be
 * constructed without both an observation and a person's confirmation, which
 * means no code path can quietly promote a guess.
 */

import { z } from 'zod';

/**
 * The five areas the product asks about. Ideal §14–§18.
 *
 * Five and not more, and the restraint is the point: every extra question is
 * one more chance for the person to feel examined and leave. The ideal's own
 * audit measured that failure mode — *"user bấm 'Không biết' 15 lần liên
 * tiếp, cảm thấy mình dốt, rồi thoát"*.
 *
 * Every one of these is answerable by looking at a screen, not by
 * understanding a schema. That is the test a sixth area would have to pass.
 */
export const ProfileArea = z.enum([
  /** §14 — does this system log people in? */
  'auth',
  /** §15 — is there a database? (asked even though we are connected to one:
   * a person may have several, and the one we hold is not necessarily the one
   * they think of.) */
  'database',
  /** §16 — does money change hands? */
  'payment',
  /** §17 — are files or images stored? */
  'storage',
  /** §18 — is there anything running on a schedule or a queue? */
  'jobs',
]);
export type ProfileArea = z.infer<typeof ProfileArea>;

export const PROFILE_AREAS = ProfileArea.options;

/**
 * The three answers every question offers. Ideal §13.
 *
 * ⚠️ `dont_know` is the DEFAULT, not a third choice of equal weight, and that
 * is the ideal's audit talking rather than a UI preference: *"User không phải
 * thú nhận mình không biết — đó là trạng thái xuất phát bình thường của mọi
 * hệ thống."* The label the window shows is a work order — "let the system
 * find out" — not a confession.
 *
 * There is deliberately no `skip`. Skipping the whole interview is a separate
 * thing the window offers ("skip all of this — just go and look"), and it
 * leaves every area at `dont_know`, which is exactly what it means.
 */
export const AreaAnswer = z.enum(['yes', 'no', 'dont_know']);
export type AreaAnswer = z.infer<typeof AreaAnswer>;

/**
 * What a person may pick after saying "yes" to an area. Ideal §14–§17.
 *
 * A closed list per area, with `other` and `dont_know` always available. The
 * lists are short on purpose: they are there to be RECOGNISED, and a list
 * long enough to need reading is a list that gets skipped.
 *
 * ⚠️ These are what the person SAYS. Nothing here is treated as true — it
 * becomes `stated` on the ladder below and has to meet what the scan actually
 * finds before it becomes anything stronger.
 */
export const AREA_OPTIONS: Readonly<Record<ProfileArea, readonly string[]>> = {
  auth: ['supabase_auth', 'firebase_auth', 'auth0', 'clerk', 'custom', 'other', 'dont_know'],
  database: [
    'postgresql',
    'mysql',
    'mongodb',
    'supabase',
    'firebase',
    'sqlite',
    'redis',
    'other',
    'dont_know',
  ],
  payment: ['stripe', 'paypal', 'vnpay', 'momo', 'bank_transfer', 'custom', 'other', 'dont_know'],
  storage: ['supabase_storage', 's3', 'cloudflare_r2', 'local_disk', 'other', 'dont_know'],
  // §18 asks the yes/no question and offers no list. Kept explicit rather than
  // omitted: an area missing from this record would be a compile error, and
  // an EMPTY list is a decision somebody can read, while an absent key is an
  // oversight nobody can tell from a decision.
  jobs: [],
};

/**
 * How sure the product is about one area. Ideal §22.
 *
 * ```text
 * unknown    nobody said, nothing was seen
 * stated     the person said so, and nothing has checked it
 * suspected  the scan saw something that points this way, unconfirmed
 * observed   the scan saw it, and can name what it saw
 * verified   observed AND the person agreed with what was shown to them
 * ```
 *
 * 🟥 `stated` is NOT above `suspected`, and the order above is not a ranking.
 * A person saying "we use Stripe" and a scan finding a `stripe_customer_id`
 * column are two different KINDS of knowing — one is a claim, the other is a
 * measurement — and the product must never merge them into a single
 * confidence number. That is the same discipline `origin` and
 * `confidenceBasis` enforce on findings.
 */
export const KnowledgeState = z.enum([
  'unknown',
  'stated',
  'suspected',
  'observed',
  'verified',
]);
export type KnowledgeState = z.infer<typeof KnowledgeState>;

/**
 * One thing the scan saw, in terms a person can check.
 *
 * `where` is a schema object the person could go and look at themselves. That
 * is the whole point: an observation nobody can go and verify is an assertion,
 * and this product does not get to make those.
 */
export const ProfileEvidence = z.object({
  /** e.g. `public.users.stripe_customer_id` — a place, not a sentence. */
  where: z.string().min(1),
  /** What about it pointed this way. Written by the backend, never a model. */
  why: z.string().refine((s) => s.trim().length > 0, { message: 'why is empty' }),
  /** When it was seen. A profile read back in March is about March. */
  observedAt: z.string().min(1),
});
export type ProfileEvidence = z.infer<typeof ProfileEvidence>;

/**
 * What the product knows about one area, and what earns that.
 *
 * A discriminated union rather than a state plus optional fields, for the
 * reason [[N49]] cost a whole slice to learn: optional fields let a state be
 * constructed without its backing, and then the ABSENCE of the backing starts
 * carrying meaning nobody wrote. Here `verified` cannot be built without an
 * observation and a confirmation, because the type has nowhere to put a
 * `verified` that lacks them.
 */
export const AreaKnowledge = z.discriminatedUnion('state', [
  /** Nobody said, nothing seen. The honest starting point for every area. */
  z.object({ state: z.literal('unknown') }),

  /**
   * The person answered. That is all this means.
   *
   * `answer: 'no'` lives here too, and it is not nothing: someone saying "no
   * payments" is a fact about their intent, and a scan that then finds a
   * `payments` table has found a DISAGREEMENT worth showing them — which is
   * far more useful than either half alone.
   */
  z.object({
    state: z.literal('stated'),
    answer: AreaAnswer,
    /** What they picked from the list, when they said yes. */
    picked: z.array(z.string()).default([]),
  }),

  /**
   * The scan saw something suggestive and can say what. Not confirmed.
   *
   * Carries `stated` for the same reason `observed` does, and this is the rung
   * where it matters most: a person who said "yes, we take payments" and a
   * table called `orders` is exactly the case the product should ASK about —
   * *"you said yes; is this it?"* — rather than either announce or discard.
   * Dropping their answer here would leave the screen with a hint and no
   * reason to raise it.
   */
  z.object({
    state: z.literal('suspected'),
    evidence: z.array(ProfileEvidence).min(1),
    stated: AreaAnswer.nullable(),
  }),

  /** The scan saw it plainly. Still not confirmed by a person. */
  z.object({
    state: z.literal('observed'),
    evidence: z.array(ProfileEvidence).min(1),
    /** Present when the person had also answered, so the two can be compared. */
    stated: AreaAnswer.nullable(),
  }),

  /**
   * Seen, shown to the person, and agreed by them.
   *
   * The only rung that requires a human, and the only one the product may
   * treat as settled. `confirmedAt` rather than a boolean: six months later
   * the question is not whether somebody agreed but WHEN, because a system
   * changes and an agreement about March is not an agreement about now.
   */
  z.object({
    state: z.literal('verified'),
    evidence: z.array(ProfileEvidence).min(1),
    confirmedAt: z.string().min(1),
  }),
]);
export type AreaKnowledge = z.infer<typeof AreaKnowledge>;

/**
 * Everything the product knows about one system.
 *
 * ⚠️ Ideal §24 is emphatic and it is built into the shape here: **a profile is
 * not the final truth.** It carries a version and it is meant to be edited.
 * Code that treats a profile as settled fact is code that will one day explain
 * an outage using a stale answer somebody gave in a hurry.
 */
export const ProjectProfile = z.object({
  /** Bumped on every edit. A profile with no version cannot be diffed. */
  version: z.number().int().positive(),
  /** ISO-8601, when this version was written. */
  updatedAt: z.string().min(1),
  /**
   * Which database this profile is about.
   *
   * A fingerprint, never a DSN — the same rule the run history lives under.
   * A profile that carried a connection string would be a credential sitting
   * in a file whose whole purpose is to be read often.
   */
  databaseFingerprint: z.string().min(1),
  /** One entry per area, all five always present. */
  areas: z.record(ProfileArea, AreaKnowledge),
});
export type ProjectProfile = z.infer<typeof ProjectProfile>;

/**
 * A profile that has been asked nothing and seen nothing.
 *
 * Every area starts at `unknown`, and that is not a placeholder — it is the
 * true state of every system before anybody looks. The product is allowed to
 * say "I do not know" about all five, and saying so is better than the
 * alternative it replaced, which was asking five questions and recording the
 * silence as if it were an answer.
 */
export function emptyProfile(databaseFingerprint: string, at: string): ProjectProfile {
  const areas = {} as Record<ProfileArea, AreaKnowledge>;
  for (const area of PROFILE_AREAS) areas[area] = { state: 'unknown' };
  return { version: 1, updatedAt: at, databaseFingerprint, areas };
}

/**
 * Where the person's answer and the scan disagree.
 *
 * 🟩 This is the reason the product asks AND scans instead of choosing one.
 * Either half alone is weaker than the pair:
 *
 * ```text
 * only asked   you learn what they believe, and they are the ones who told
 *              you they do not understand the system
 * only scanned you learn what is there, and nothing about what it is FOR
 * both         a disagreement is the most valuable thing on the screen —
 *              it is the question they did not know to ask
 * ```
 *
 * Ideal §12's audit demanded this order: scan first because it is cheap and
 * automatic, then ask the person only to RECOGNISE what was found.
 */
export type ProfileConflict = {
  area: ProfileArea;
  /** What the person said. */
  stated: AreaAnswer;
  /** What was actually found, if anything. */
  evidence: readonly ProfileEvidence[];
  /**
   * Which way round the disagreement goes. Named rather than derived, because
   * the two directions mean completely different things to a reader and the
   * product must not phrase them the same way.
   *
   *   `said_no_found_yes`  they did not know it was there — the useful case
   *   `said_yes_found_no`  we could not see what they described. Usually a
   *                        limit of ours (it lives outside this database),
   *                        NOT evidence they are wrong.
   */
  direction: 'said_no_found_yes' | 'said_yes_found_no';
};

/**
 * Finds every area where what was said and what was seen do not line up.
 *
 * ⚠️ `said_yes_found_no` is deliberately reported, and deliberately NOT called
 * a mistake. This product reads one database. Someone answering "yes, we have
 * file storage" is almost certainly right and it simply is not in here —
 * which is a fact about our coverage, and the report has to say so in those
 * terms. Treating it as their error would be the product mistaking the edge
 * of its own vision for the edge of the world.
 */
export function conflictsIn(profile: ProjectProfile): ProfileConflict[] {
  const out: ProfileConflict[] = [];

  for (const area of PROFILE_AREAS) {
    const known = profile.areas[area];
    if (known === undefined) continue;
    // Only `observed` carries both halves — what was seen AND what was said.
    // The other rungs cannot disagree with anything: `stated` has nothing
    // measured against it, `suspected` is too weak to contradict a person,
    // and `verified` is by construction the case where they already agreed.
    if (known.state !== 'observed' || known.stated === null) continue;

    if (known.stated === 'no') {
      out.push({ area, stated: 'no', evidence: known.evidence, direction: 'said_no_found_yes' });
    }
  }

  // The other direction: they said yes and the scan came back with nothing.
  //
  // 🟥 This branch was missing until 2026-08-28, and the gap had a shape worth
  // naming: `ProfileConflict` declared two directions, the window had copy
  // written for both, and only one of them could ever be produced. Prose for a
  // state that cannot arise is the same failure as an assertion that cannot go
  // red — it reads as covered and covers nothing.
  //
  // ⚠️ Reported, and deliberately NOT called a mistake of theirs. This product
  // reads one database. Somebody answering "yes, we store files" is very
  // probably right and it simply is not in here — which is a fact about OUR
  // coverage. The direction is a separate value precisely so the sentence can
  // be about that and never about them being wrong.
  for (const area of PROFILE_AREAS) {
    const known = profile.areas[area];
    if (known === undefined || known.state !== 'stated') continue;
    if (known.answer !== 'yes') continue;
    out.push({ area, stated: 'yes', evidence: [], direction: 'said_yes_found_no' });
  }

  return out;
}

/**
 * Whether this profile can decide what to scan first.
 *
 * A profile of five `unknown`s is VALID — the person skipped everything, which
 * is the button the ideal's audit expects to be pressed most — and it still
 * has to produce a working scan plan. This function exists so that fact is
 * asserted somewhere rather than assumed: it returns true for the empty
 * profile, and any future change that makes an all-unknown profile unusable
 * fails here rather than in front of a person who skipped.
 */
export function canPlanFrom(profile: ProjectProfile): boolean {
  return PROFILE_AREAS.every((area) => profile.areas[area] !== undefined);
}

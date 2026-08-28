/**
 * What the schema itself says about the five areas — ideal §12's audit.
 *
 * > *"ĐÚNG: Scan trước (rẻ, tự động) → Trình bày cái tìm được → User chỉ bấm
 * > Đúng/Sai."*
 *
 * The person is asked five questions they can answer by looking at a screen.
 * This is the other half: the product goes and looks for itself, so what
 * reaches them afterwards is a thing to RECOGNISE rather than a thing to
 * remember.
 *
 * ## The two rules this file lives under
 *
 * **① Names only. No row is read here.** Table names, column names and schema
 * names, and nothing else. Reading VALUES to decide what a system does is the
 * entity-bridge work (ideal §32 tier 2), and Sol's objection to it stands: it
 * can scan production hard, read PII outside its purpose, and still only
 * prove a value SHAPE rather than a relationship. None of that belongs in a
 * five-question onboarding.
 *
 * **② A guess is never promoted to a sighting.** Two strengths, and they are
 * different in kind rather than in degree:
 *
 * ```text
 * certain     the name can mean nothing else here. A Supabase `auth` schema
 *             is Supabase Auth. There is no second reading.
 * suggestive  the name is what somebody would call this, and also what they
 *             would call several other things. `tasks` is a job queue in one
 *             product and a to-do list in the next.
 * ```
 *
 * `certain` becomes `observed` on the ladder; `suggestive` becomes
 * `suspected`, and a suspicion is shown as a question rather than as news.
 * The whole product is built on not saying more than was measured, and a
 * profile is where that discipline is cheapest to break — nobody audits an
 * onboarding screen the way they audit a finding.
 */

import { PROFILE_AREAS } from './project-profile.js';
import type {
  AreaAnswer,
  AreaKnowledge,
  ProfileArea,
  ProfileEvidence,
  ProjectProfile,
} from './project-profile.js';

/**
 * The slice of a schema this file needs.
 *
 * Named here rather than importing `SchemaGraph` from the connector, and the
 * direction matters: contracts must not depend on the package that talks to
 * Postgres. It also keeps this function testable with a literal, which is how
 * every rule below is pinned without a database.
 */
export type SchemaShape = {
  readonly schemas: readonly string[];
  readonly tables: readonly { readonly schema: string; readonly table: string }[];
  readonly columns: readonly {
    readonly schema: string;
    readonly table: string;
    readonly name: string;
  }[];
};

/** How strongly one sighting is meant. See rule ② above. */
export type Strength = 'certain' | 'suggestive';

export type Observation = {
  readonly area: ProfileArea;
  readonly strength: Strength;
  readonly evidence: ProfileEvidence;
};

/**
 * Schemas whose NAME settles the question.
 *
 * Supabase creates `auth` and `storage`; `pg_cron` creates `cron`. A person
 * who has one of these did not name it by accident, and no other product puts
 * a schema there by coincidence.
 */
const DECISIVE_SCHEMAS: Readonly<Record<string, ProfileArea>> = {
  auth: 'auth',
  storage: 'storage',
  cron: 'jobs',
};

/**
 * Column-name fragments that settle an area, with the reason each is decisive.
 *
 * `stripe` is the model for all of them: a column called `stripe_customer_id`
 * exists because somebody integrated Stripe. There is no second reading, and
 * the id VALUES are never looked at to reach that conclusion.
 */
const DECISIVE_COLUMN_FRAGMENTS: readonly {
  readonly fragment: string;
  readonly area: ProfileArea;
}[] = [
  { fragment: 'stripe', area: 'payment' },
  { fragment: 'paypal', area: 'payment' },
  { fragment: 'password_hash', area: 'auth' },
  { fragment: 'encrypted_password', area: 'auth' },
];

/**
 * Table names that SUGGEST an area and settle nothing.
 *
 * ⚠️ Every entry here is a name somebody would also use for something else,
 * and that is why the list is allowed to be generous: nothing it produces is
 * ever stated as fact. `orders` is the clearest case — an order is not a
 * payment, plenty of systems have orders and take money elsewhere, and a
 * product that announced "you take payments" on the strength of a table
 * called `orders` would be inventing a business model for somebody.
 */
const SUGGESTIVE_TABLES: readonly {
  readonly names: readonly string[];
  readonly area: ProfileArea;
}[] = [
  { names: bothForms(['user', 'account', 'session', 'user_session', 'login']), area: 'auth' },
  {
    names: bothForms(['payment', 'invoice', 'order', 'subscription', 'charge', 'transaction']),
    area: 'payment',
  },
  {
    names: bothForms(['file', 'attachment', 'upload', 'document', 'media', 'image']),
    area: 'storage',
  },
  {
    names: bothForms(['job', 'job_queue', 'queue', 'scheduled_job', 'background_job', 'worker']),
    area: 'jobs',
  },
];

/**
 * Each name in the singular and with an `s` on the end.
 *
 * 🟥 Added 2026-08-28 after running this against Pagila and getting nothing.
 * Pagila's table is `payment`; the list said `payments`; the product looked
 * straight at a payments table and reported that it had seen nothing. Half of
 * every real schema names its tables in the singular and the list only
 * described the other half.
 *
 * ⚠️ It appends an `s` and does nothing else. It is NOT an attempt at English
 * pluralisation and must not grow into one — `person`/`people` and
 * `index`/`indices` would each be a guess about somebody's naming, and the
 * cost of missing one is a suggestion nobody sees while the cost of a wrong
 * rule is a suggestion about a table that means something else entirely.
 *
 * Anything irregular goes in the list in both forms, by hand, where a reader
 * can see it.
 */
function bothForms(names: readonly string[]): readonly string[] {
  return names.flatMap((n) => [n, `${n}s`]);
}

function lower(s: string): string {
  return s.toLowerCase();
}

/**
 * Which area a table name belongs to, or null when it says nothing.
 *
 * Reads the SAME list `observeAreas` reads, and is exported so that nothing
 * else has to keep a second copy of it — §4.27 is the whole reason this is a
 * function rather than a list somebody else could reproduce. A scan plan that
 * ranked tables by its own idea of what `orders` means would drift from what
 * the observation says about the same word, and the two would disagree about
 * one database with nothing to notice it.
 *
 * ⚠️ First match wins, and the lists do not overlap today. If they ever do,
 * the winner is whichever area is declared first — which is a decision, and
 * one that belongs beside the lists rather than at a call site.
 */
export function areaOfTable(table: string): ProfileArea | null {
  const name = lower(table);
  for (const { names, area } of SUGGESTIVE_TABLES) {
    if (names.includes(name)) return area;
  }
  return null;
}

/**
 * Everything the schema says about the five areas.
 *
 * Returns one entry per SIGHTING rather than one per area: two independent
 * reasons to think a system takes payments is a different situation from one,
 * and collapsing them here would throw that away before anybody could see it.
 *
 * `database` is not looked for and never appears. The product is holding an
 * open connection to a Postgres database while this runs, so "is there a
 * database" is answered by the connection rather than by pattern-matching a
 * name — and the caller, which knows which database it is connected to, is
 * the only place that can say WHICH one without guessing.
 */
export function observeAreas(shape: SchemaShape, observedAt: string): Observation[] {
  const out: Observation[] = [];

  for (const schema of shape.schemas) {
    const area = DECISIVE_SCHEMAS[lower(schema)];
    if (area === undefined) continue;
    out.push({
      area,
      strength: 'certain',
      evidence: {
        where: schema,
        why: `there is a schema called "${schema}", which is created by the tool that owns it and by nothing else`,
        observedAt,
      },
    });
  }

  for (const column of shape.columns) {
    for (const { fragment, area } of DECISIVE_COLUMN_FRAGMENTS) {
      if (!lower(column.name).includes(fragment)) continue;
      out.push({
        area,
        strength: 'certain',
        evidence: {
          where: `${column.schema}.${column.table}.${column.name}`,
          // The reason names the fragment rather than the conclusion, so a
          // person reading it can disagree with the step rather than only
          // with the verdict.
          why: `this column's name contains "${fragment}"`,
          observedAt,
        },
      });
    }
  }

  for (const table of shape.tables) {
    for (const { names, area } of SUGGESTIVE_TABLES) {
      if (!names.includes(lower(table.table))) continue;
      out.push({
        area,
        strength: 'suggestive',
        evidence: {
          where: `${table.schema}.${table.table}`,
          why: `there is a table called "${table.table}", which often means this and sometimes does not`,
          observedAt,
        },
      });
    }
  }

  return out;
}

/**
 * The strongest thing seen for one area, and everything that supports it.
 *
 * Sightings of the WEAKER kind are kept when a stronger one exists, rather
 * than discarded as redundant: a person shown "you have a Supabase auth
 * schema" is better served by also seeing the `users` table beside it, and
 * the cost of keeping it is one line on a card.
 */
export function strongestFor(
  observations: readonly Observation[],
  area: ProfileArea,
): { strength: Strength; evidence: ProfileEvidence[] } | null {
  const mine = observations.filter((o) => o.area === area);
  if (mine.length === 0) return null;
  const strength: Strength = mine.some((o) => o.strength === 'certain') ? 'certain' : 'suggestive';
  return { strength, evidence: mine.map((o) => o.evidence) };
}

/**
 * One person's answer about one area, as it crosses into the contract.
 *
 * Deliberately not the desktop's `AreaReply`: that type lives in the shell's
 * IPC surface and this package must not know a shell exists. The two agree by
 * having the same fields, and the shell's compiler checks that when it calls.
 */
export type StatedAnswer = {
  readonly area: ProfileArea;
  readonly answer: AreaAnswer;
  readonly picked?: readonly string[];
};

/**
 * Puts what was said next to what was seen, and rules on each area.
 *
 * This is ideal §22's ladder being climbed for the first time, and the rules
 * are short enough to state whole:
 *
 * ```text
 * seen for certain      → observed   (carries what they said, so the screen
 *                                     can show agreement or disagreement)
 * seen suggestively     → suspected  (carries what they said, so the screen
 *                                     knows whether to ask or to mention)
 * nothing seen, said    → stated     (their claim, and the product has not
 *                                     checked it — which the rung admits)
 * nothing seen, unsaid  → unknown    (the honest starting point, and the
 *                                     answer for anyone who skipped)
 * ```
 *
 * 🟥 `verified` is NEVER produced here, and that is the point of it existing.
 * It requires a person to have looked at what was found and agreed, which is
 * an interaction, not a computation. A reconcile that could mint `verified`
 * would make the one rung that means "a human signed this" reachable without
 * a human — and every later screen reads that rung as settled.
 *
 * ⚠️ Someone saying `yes` does NOT promote a suggestion to a sighting. Two
 * weak things do not make a strong one when they are weak for unrelated
 * reasons: a person can be right about their system and the table can still
 * be named after something else. The pair is a good reason to ASK, and asking
 * is what `suspected` carrying `stated` is for.
 */
export function reconcile(
  base: ProjectProfile,
  said: readonly StatedAnswer[],
  observations: readonly Observation[],
  at: string,
): ProjectProfile {
  const byArea = new Map<ProfileArea, StatedAnswer>();
  for (const reply of said) byArea.set(reply.area, reply);

  const areas = {} as Record<ProfileArea, AreaKnowledge>;

  for (const area of PROFILE_AREAS) {
    const reply = byArea.get(area) ?? null;
    const seen = strongestFor(observations, area);

    if (seen !== null) {
      areas[area] =
        seen.strength === 'certain'
          ? { state: 'observed', evidence: seen.evidence, stated: reply?.answer ?? null }
          : { state: 'suspected', evidence: seen.evidence, stated: reply?.answer ?? null };
      continue;
    }

    if (reply !== null) {
      areas[area] = { state: 'stated', answer: reply.answer, picked: [...(reply.picked ?? [])] };
      continue;
    }

    // Nothing said and nothing seen. Not a gap to be filled — the true state
    // of an area nobody has asked about and nothing has looked at.
    areas[area] = { state: 'unknown' };
  }

  return {
    ...base,
    // Bumped because the areas changed. §24: a profile is meant to be edited,
    // and an edit nobody can date or order is an edit nobody can diff.
    version: base.version + 1,
    updatedAt: at,
    areas,
  };
}

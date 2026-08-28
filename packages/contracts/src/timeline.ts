/**
 * G3, second half: the shape of the answer.
 *
 * Ideal §33 asks for four things and no more:
 *
 * ```text
 * cái gì xảy ra · lúc nào · chỗ nào đứt · mấy ca giống vậy
 * what happened · when     · where it broke · how many like it
 * ```
 *
 * Nothing here talks to a database. The runner reads rows; this decides what
 * they are allowed to add up to. Splitting it that way is the same move
 * `serve-paths.ts` makes away from `serve.ts` — the decisions can then be
 * exercised by the suite without a connection, and the four rules below are
 * decisions, not plumbing.
 *
 * ## The four rules, and what each one refuses to say
 *
 * **① A step with no time is never placed as if it had one.** The ideal's
 * example is a sequence of clock times, and the pull towards inventing that
 * ordering is strong: rows come back in *some* order and printing them in it
 * looks like a timeline. It would be a timeline of the query planner. So the
 * steps come back in two groups — those with a measured time, in that order,
 * then those without, in route order — and each of the second group carries
 * `placedWithoutTime` so a renderer cannot print it as a clock reading.
 *
 * **② The break is the FIRST hop with no rows, and everything past it is
 * unreachable rather than empty.** If a customer has no rental, then "0
 * payments" is not a finding about payments — the question never got there.
 * Reporting both as zero is how a reader concludes two things are wrong when
 * one is.
 *
 * **③ `similar` is null until something counted it.** Never zero-because-nobody-
 * looked. This product already has four distinct meanings for the number zero
 * written down in its fixtures; this is the fifth place the distinction
 * matters, and the type carries it instead of a comment.
 *
 * **④ A table with no time column is MEASURED, not guessed at.** The model may
 * name `events_not_recorded` in its `outside` list, and it may forget to. The
 * runner can see that a table has no timestamp at all, and what it sees wins.
 * An admission the product can measure is one it must not leave to a model.
 */

import { pathTier } from './entity-graph.js';
import type { EdgeTier, EntityEdge } from './entity-graph.js';
import { OutsideKind } from './bounded-lookup.js';

/** One hop's worth of what was found, as the runner read it. */
export type HopResult = {
  /** `schema.table` this hop landed on. */
  readonly entity: string;
  /** The column the route arrived on. Named so a reader can go and look. */
  readonly via: string;
  /** The edges walked to get here; the tier is taken from the weakest. */
  readonly path: readonly EntityEdge[];
  /** How many rows related to the subject were found here. */
  readonly rows: number;
  /**
   * When the earliest of them happened, ISO, or null.
   *
   * Null means one of two different things, and they are kept apart by
   * `timeColumn` rather than folded together here: either the table records no
   * time at all, or it does and these rows left it empty.
   */
  readonly at: string | null;
  /** The time column used, or null when the table has none to use. */
  readonly timeColumn: string | null;
};

export type TimelineStep = {
  readonly entity: string;
  readonly via: string;
  readonly rows: number;
  readonly at: string | null;
  readonly tier: EdgeTier;
  /** True when this step's position comes from the route, not from a clock. */
  readonly placedWithoutTime: boolean;
};

/** Where the chain stopped, and how much the stop is worth. */
export type TimelineBreak = {
  /** The last entity that had rows. */
  readonly after: string;
  /** The entity that had none. */
  readonly at: string;
  /** The column the route would have arrived on. */
  readonly via: string;
  /**
   * The weakest hop on the way here.
   *
   * A break found across a `guessed` edge is a break in a relationship nobody
   * declared and nobody counted — it may be no break at all, only two tables
   * that were never related. Printing it at the same weight as a break across
   * a foreign key is the failure `pathTier` exists to prevent.
   */
  readonly tier: EdgeTier;
};

export type Timeline = {
  /** `schema.table` the question was aimed at. */
  readonly subject: string;
  /** In time order where times exist, route order where they do not. */
  readonly steps: readonly TimelineStep[];
  /** Where it stopped, or null when the whole route had rows. */
  readonly brokeAt: TimelineBreak | null;
  /** How many other subjects show the same break. Null when nobody counted. */
  readonly similar: number | null;
  /** What this question needs that a database does not hold. */
  readonly outside: readonly OutsideKind[];
  /** Entities on the route that record no time at all. */
  readonly untimed: readonly string[];
  /** Hops the break made unreachable. Not empty — never asked. */
  readonly unreached: readonly string[];
};

/**
 * Assembles what the runner read into what a reader may be shown.
 *
 * `hops` arrives in route order, starting at the subject. `claimedOutside` is
 * whatever the model said; it is merged with what the rows actually show, and
 * the measured half cannot be dropped by a model that forgot it.
 */
export function timelineFrom(
  subject: string,
  hops: readonly HopResult[],
  claimedOutside: readonly OutsideKind[],
  similar: number | null = null,
): Timeline {
  // ② The break is the first hop with nothing, and it ends the walk. Later
  // hops are not empty; they were never reached, and the two words mean
  // different things to somebody deciding what to go and fix.
  const breakIndex = hops.findIndex((h) => h.rows === 0);
  const reached = breakIndex === -1 ? hops : hops.slice(0, breakIndex);
  const unreached = breakIndex === -1 ? [] : hops.slice(breakIndex + 1).map((h) => h.entity);

  const steps: TimelineStep[] = reached.map((h) => ({
    entity: h.entity,
    via: h.via,
    rows: h.rows,
    at: h.at,
    tier: pathTier(h.path),
    placedWithoutTime: h.at === null,
  }));

  // ① Two groups, not one sort.
  //
  // 🟥 The first version compared "by time when both have one, by route order
  // otherwise", which is not an ordering at all: with a 10:00 step, an untimed
  // step and an 09:00 step, it says 10:00 precedes untimed, untimed precedes
  // 09:00, and 09:00 precedes 10:00. A comparator with a cycle in it leaves
  // `sort` free to return anything, and what it returned looked plausible —
  // route order, which is exactly the invented timeline this rule exists to
  // refuse. The test caught it because it asserted the ORDER rather than that
  // sorting had happened.
  //
  // What is left is honest and total: steps with a measured time are ordered
  // by it, then steps with none follow in route order. The split is the claim
  // — these I can place, these I cannot — and `placedWithoutTime` marks each
  // one so a renderer cannot print the second group as clock readings.
  const timed = steps.filter((s) => s.at !== null).sort((a, b) => a.at!.localeCompare(b.at!));
  const untimedSteps = steps.filter((s) => s.at === null);
  const ordered = [...timed, ...untimedSteps];

  let brokeAt: TimelineBreak | null = null;
  if (breakIndex !== -1) {
    const missing = hops[breakIndex]!;
    brokeAt = {
      after: breakIndex === 0 ? subject : hops[breakIndex - 1]!.entity,
      at: missing.entity,
      via: missing.via,
      tier: pathTier(missing.path),
    };
  }

  // ④ Measured, not claimed. A table the runner found no time column on is
  // untimed whatever the model said, and the admission is added here rather
  // than hoped for.
  const untimed = hops.filter((h) => h.timeColumn === null).map((h) => h.entity);

  const outside = new Set<OutsideKind>(claimedOutside);
  if (untimed.length > 0) outside.add('events_not_recorded');

  return {
    subject,
    steps: ordered,
    brokeAt,
    // ③ Passed through, never defaulted to 0. Null is "nobody counted".
    similar,
    outside: [...outside],
    untimed,
    unreached,
  };
}

/**
 * Whether a timeline is worth putting in front of somebody.
 *
 * A walk that reached nothing and broke nowhere has found no rows and no
 * absence — it is the shape a reader takes for "everything is fine", and it is
 * not that. It is "I did not find your subject at all", which is a different
 * sentence and the renderer needs to know which one it is writing.
 */
export function timelineSaysNothing(timeline: Timeline): boolean {
  return timeline.steps.length === 0 && timeline.brokeAt === null;
}

/**
 * The weakest evidence anywhere in the timeline.
 *
 * A reader is entitled to one word for how much the whole account is worth,
 * and it has to be the worst hop rather than the best — the same rule
 * `pathTier` applies within a path, applied across the account built out of
 * several. Null when there is nothing to weigh.
 */
export function timelineTier(timeline: Timeline): EdgeTier | null {
  const tiers: EdgeTier[] = timeline.steps.map((s) => s.tier);
  if (timeline.brokeAt !== null) tiers.push(timeline.brokeAt.tier);
  if (tiers.length === 0) return null;
  if (tiers.includes('guessed')) return 'guessed';
  if (tiers.includes('measured')) return 'measured';
  return 'declared';
}

/**
 * What to look at first — ideal §25 and §26.
 *
 * > *"Mỗi project không nên scan giống nhau… Điều này giúp giảm việc scan vô
 * > ích."*
 *
 * A profile that changes nothing is a form somebody filled in. This is where
 * it earns its keep: the areas a person cares about, and the ones the scan
 * actually found, decide what gets examined before anything else does.
 *
 * ## Why order is not cosmetic
 *
 * Every scan runs under a query budget, because it is spending somebody else's
 * production database. When that budget runs out the remaining targets are set
 * aside and disclosed — honestly, but set aside all the same. So the order is
 * the answer to *"if I only get to look at half of this, which half?"*, and
 * before this the answer was whatever order the catalog happened to return.
 *
 * ```text
 * without a plan   the columns checked are the ones that sorted first
 * with a plan      the columns checked are the ones this system is about
 * ```
 *
 * ## What a plan is NOT
 *
 * It is not permission and it is not a filter. Nothing is excluded from being
 * looked at; an area nobody mentioned is last, not absent. A plan that could
 * remove things from the scan would be a plan that could quietly narrow what a
 * report covers — and the scope strip would go on saying the same thing.
 */

import { PROFILE_AREAS } from './project-profile.js';
import type { ProfileArea, ProjectProfile } from './project-profile.js';
import { areaOfTable } from './profile-observe.js';

/**
 * The areas, most interesting first.
 *
 * A total order over all five, never a subset. A plan that named only what
 * mattered would leave the caller to invent an order for the rest, and the
 * invented one would differ between callers.
 */
export type ScanPlan = {
  readonly order: readonly ProfileArea[];
  /**
   * Why this order, in one sentence per area, for a person who asks.
   *
   * Kept beside the order rather than derived from it later: the reason a
   * thing was looked at first is part of what the product owes a reader, and
   * re-deriving it from a rung after the fact would be reconstructing an
   * explanation rather than recording one.
   */
  readonly because: Readonly<Record<ProfileArea, string>>;
};

/**
 * How much attention each rung earns.
 *
 * ⚠️ The two halves are ranked deliberately, and this is the ranking that
 * would be easiest to get backwards:
 *
 * ```text
 * verified   they looked at what was found and agreed. Nothing is more
 *            certain than that, and it is the only rung a human signed.
 * observed   the scan saw it plainly.
 * stated     they said so. A claim about their own system beats a hint from
 *            a table name — they are wrong sometimes, and a table called
 *            `orders` is ambiguous ALWAYS.
 * suspected  a name that often means this and sometimes does not.
 * unknown    nobody said, nothing seen. Last, and still looked at.
 * ```
 *
 * 🟥 `stated` above `suspected` is the arguable one, so the argument is here.
 * A person saying "we take payments" is a statement about the thing itself. A
 * table called `payment` is a statement about a NAME, and this file's own
 * observation rules call that ambiguous by construction. Ranking the name
 * higher would mean the product trusted its own guess over the account of the
 * person who runs the system — which is the posture ideal §13 exists to
 * refuse.
 */
const WEIGHT: Readonly<Record<string, number>> = {
  verified: 4,
  observed: 3,
  stated: 2,
  suspected: 1,
  unknown: 0,
};

/**
 * The plan for one profile.
 *
 * Stable: two profiles that say the same thing produce the same order, and
 * areas that tie keep the order `PROFILE_AREAS` declares. Without that a plan
 * would differ between runs on nothing, and a diff of two scans would report
 * an attention change that never happened.
 */
export function scanPlanFrom(profile: ProjectProfile): ScanPlan {
  const scored = PROFILE_AREAS.map((area, index) => {
    const known = profile.areas[area];
    const state = known?.state ?? 'unknown';
    // A `no` earns nothing. Somebody saying an area is not part of their
    // system is the clearest instruction in the whole profile, and promoting
    // it for having been mentioned would read every answer as interest.
    const said = known?.state === 'stated' ? known.answer : null;
    const weight = said === 'no' ? 0 : (WEIGHT[state] ?? 0);
    return { area, index, weight, state, said };
  });

  const order = [...scored]
    .sort((a, b) => (b.weight - a.weight) || (a.index - b.index))
    .map((s) => s.area);

  const because = {} as Record<ProfileArea, string>;
  for (const s of scored) because[s.area] = reasonFor(s.state, s.said);

  return { order, because };
}

function reasonFor(state: string, said: string | null): string {
  if (said === 'no') return 'you said this is not part of your system';
  switch (state) {
    case 'verified':
      return 'you looked at what I found here and agreed';
    case 'observed':
      return 'I saw this in your schema and can point at where';
    case 'stated':
      return 'you told me about this';
    case 'suspected':
      return 'a name in your schema might mean this';
    default:
      return 'nobody mentioned it and I saw nothing — so it goes last, not away';
  }
}

/**
 * Where one table sits in a plan. Lower is looked at earlier.
 *
 * A table whose name says nothing about any area gets the position after the
 * last one — NOT excluded, and not silently first either. Most tables in most
 * databases are ordinary domain tables, and a plan that pushed all of them
 * ahead of a payments table because they matched nothing would be worse than
 * no plan at all.
 */
export function planRank(plan: ScanPlan, table: string): number {
  const area = areaOfTable(table);
  if (area === null) return plan.order.length;
  const at = plan.order.indexOf(area);
  return at === -1 ? plan.order.length : at;
}

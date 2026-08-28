/**
 * The order a profile puts things in — ideal §25 and §26.
 *
 * > *"Mỗi project không nên scan giống nhau… Điều này giúp giảm việc scan vô
 * > ích."*
 *
 * A profile that changes nothing is a form somebody filled in. This is the
 * file where it changes something, so these are the rules that decide whether
 * it changed the RIGHT thing:
 *
 *   1. Two different profiles produce two different orders. That is G1's
 *      stated acceptance and it is asserted here rather than assumed.
 *   2. A profile of five unknowns still produces a complete, valid order.
 *      That is the person who skipped, and the ideal expects them to be the
 *      majority.
 *   3. The order is TOTAL. Every area appears, always. A plan is attention,
 *      never permission — nothing is ever excluded from being looked at.
 *   4. It is stable. Ties keep declaration order, so two scans of an
 *      unchanged system cannot report an attention change nobody made.
 *   5. What a person SAID outranks what a NAME hinted.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AreaKnowledge,
  PROFILE_AREAS,
  emptyProfile,
  observeAreas,
  planRank,
  reconcile,
  scanPlanFrom,
} from '../src/index.js';
import type { ProjectProfile, SchemaShape, StatedAnswer } from '../src/index.js';

const AT = '2026-08-28T00:00:00.000Z';
const BASE = emptyProfile('fp-plan', AT);

function withArea(area: (typeof PROFILE_AREAS)[number], known: unknown): ProjectProfile {
  return { ...BASE, areas: { ...BASE.areas, [area]: AreaKnowledge.parse(known) } };
}

/** One rung of the ladder, filled in with the least interesting content that satisfies it. */
function rung(state: string): unknown {
  switch (state) {
    case 'verified':
      return { state, evidence: SEEN, confirmedAt: AT };
    case 'observed':
    case 'suspected':
      return { state, evidence: SEEN, stated: null };
    case 'stated':
      return { state, answer: 'yes', picked: [] };
    default:
      return { state: 'unknown' };
  }
}

const SEEN = [
  { where: 'public.users.stripe_customer_id', why: 'name contains stripe', observedAt: AT },
];

describe('the order a profile asks for', () => {
  it('🟥 two different profiles give two different orders', () => {
    // G1's acceptance, in one assertion. If this cannot fail, the profile is
    // decorative and the five questions were a form.
    const caresAboutPayment = withArea('payment', {
      state: 'observed',
      evidence: SEEN,
      stated: 'yes',
    });
    const caresAboutStorage = withArea('storage', {
      state: 'observed',
      evidence: SEEN,
      stated: 'yes',
    });

    const a = scanPlanFrom(caresAboutPayment).order;
    const b = scanPlanFrom(caresAboutStorage).order;
    assert.notDeepEqual(a, b, 'two systems with nothing in common are scanned identically');
    assert.equal(a[0], 'payment');
    assert.equal(b[0], 'storage');
  });

  it('🟥 the person who skipped everything still gets a complete order', () => {
    // Rule 2. A plan that needed answers would fail for exactly the people
    // this product is for.
    const plan = scanPlanFrom(BASE);
    assert.equal(plan.order.length, PROFILE_AREAS.length);
    assert.deepEqual([...plan.order].sort(), [...PROFILE_AREAS].sort());
  });

  it('🟥 the order is total — an area nobody mentioned is last, never absent', () => {
    // Rule 3. A plan able to drop an area would be a way to narrow what a
    // report covers while the scope strip went on saying the same thing.
    const plan = scanPlanFrom(withArea('payment', { state: 'observed', evidence: SEEN, stated: null }));
    for (const area of PROFILE_AREAS) {
      assert.ok(plan.order.includes(area), `${area} vanished from the plan`);
    }
  });

  it('ties keep declaration order, so an unchanged system plans the same way twice', () => {
    // Rule 4. Without this a diff of two scans would report an attention
    // change that never happened.
    assert.deepEqual(scanPlanFrom(BASE).order, [...PROFILE_AREAS]);
    assert.deepEqual(scanPlanFrom(BASE).order, scanPlanFrom(BASE).order);
  });
});

describe('what outranks what', () => {
  it('agreement beats a sighting, and a sighting beats a hint', () => {
    // Compared head to head, not against an all-unknown profile. `jobs` is
    // declared LAST, so any rung at all lifts it past four zeroes — which
    // proves that something moved and nothing about which rung outranks which.
    // The first draft of this test asserted exactly that weaker thing and went
    // red for the right reason.
    const pairs: readonly [string, string][] = [
      ['verified', 'observed'],
      ['observed', 'stated'],
      ['stated', 'suspected'],
      ['suspected', 'unknown'],
    ];

    for (const [stronger, weaker] of pairs) {
      // `jobs` carries the stronger rung and is declared LAST; `auth` carries
      // the weaker one and is declared FIRST. So declaration order is pulling
      // the wrong way throughout, and only the weighting can produce the
      // expected result — §4.24, a comparison both sides of which would come
      // out the same anyway proves nothing.
      const p: ProjectProfile = {
        ...BASE,
        areas: {
          ...BASE.areas,
          jobs: AreaKnowledge.parse(rung(stronger)),
          auth: AreaKnowledge.parse(rung(weaker)),
        },
      };
      const order = scanPlanFrom(p).order;
      assert.ok(
        order.indexOf('jobs') < order.indexOf('auth'),
        `${weaker} outranked ${stronger}`,
      );
    }
  });

  it('🟥 what a person said outranks what a name hinted', () => {
    // Rule 5, and the ranking most likely to be reversed by somebody tidying.
    // A person saying "we take payments" is a statement about the THING. A
    // table called `payment` is a statement about a NAME, which this codebase
    // calls ambiguous by construction. Trusting the name more would be the
    // product preferring its own guess to the account of the person who runs
    // the system.
    const said = withArea('jobs', { state: 'stated', answer: 'yes', picked: [] });
    const hinted = withArea('auth', { state: 'suspected', evidence: SEEN, stated: null });
    const both: ProjectProfile = {
      ...BASE,
      areas: { ...said.areas, auth: hinted.areas.auth! },
    };
    const order = scanPlanFrom(both).order;
    assert.ok(
      order.indexOf('jobs') < order.indexOf('auth'),
      'a table name outranked something a person told us',
    );
  });

  it('🟥 "no" is an instruction, not interest — and it goes last', () => {
    // Promoting an area for having been mentioned would read every answer as
    // engagement, including the one that says "this is not part of my system".
    //
    // ⚠️ This test used to assert `no` kept its DECLARATION position, which
    // pinned the weaker rule the code actually had: `no` scored zero, tied
    // with every area nobody had been asked about, and the tie was broken by
    // where the area happens to sit in `PROFILE_AREAS`. So "we do not use
    // auth" and "nobody has mentioned auth" produced the same plan.
    //
    // Changed 2026-08-28 with the code. A person ruling an area out is
    // spending their budget elsewhere on purpose, and last is what that means.
    const saidNo = withArea('auth', { state: 'stated', answer: 'no', picked: [] });
    const order = scanPlanFrom(saidNo).order;
    assert.equal(order.at(-1), 'auth');
    for (const area of PROFILE_AREAS) {
      if (area === 'auth') continue;
      assert.ok(order.indexOf(area) < order.indexOf('auth'), `${area} lost to a ruled-out area`);
    }
    assert.match(scanPlanFrom(saidNo).because.auth, /not part of your system/);
  });

  it('every area carries a reason a person could be shown', () => {
    const plan = scanPlanFrom(BASE);
    for (const area of PROFILE_AREAS) {
      assert.ok(plan.because[area].trim().length > 0, `${area} is ordered for no stated reason`);
    }
  });
});

describe('ranking one table', () => {
  const plan = scanPlanFrom(
    withArea('payment', { state: 'observed', evidence: SEEN, stated: 'yes' }),
  );

  it('a table named for the leading area comes first', () => {
    assert.equal(planRank(plan, 'payment'), 0);
    assert.equal(planRank(plan, 'payments'), 0);
  });

  it('🟥 a table whose name says nothing goes last, not first', () => {
    // Most tables in most databases are ordinary domain tables. A plan that
    // pushed all of them ahead of a payments table because they matched
    // nothing would be worse than no plan at all.
    assert.equal(planRank(plan, 'widget_revisions'), plan.order.length);
    assert.ok(planRank(plan, 'widget_revisions') > planRank(plan, 'payment'));
  });

  it('reads the same table-name list the observation reads', () => {
    // §4.27. If this file kept its own idea of what `orders` means, the two
    // would disagree about one database with nothing to notice it.
    const seen = observeAreas(
      { schemas: [], tables: [{ schema: 'public', table: 'orders' }], columns: [] },
      AT,
    );
    assert.equal(seen[0]?.area, 'payment');
    assert.equal(planRank(plan, 'orders'), planRank(plan, 'payment'));
  });
});

describe('a plan built from a real reconcile', () => {
  it('answers and sightings together move the order', () => {
    const seen = observeAreas(
      {
        schemas: [],
        tables: [{ schema: 'public', table: 'payment' }],
        columns: [{ schema: 'public', table: 'users', name: 'stripe_customer_id' }],
      },
      AT,
    );
    const p = reconcile(BASE, [{ area: 'jobs', answer: 'yes' }], seen, AT);
    const order = scanPlanFrom(p).order;

    // `payment` was seen for certain — top. `jobs` was only claimed — above
    // the untouched areas, below the sighting.
    assert.equal(order[0], 'payment');
    assert.ok(order.indexOf('jobs') < order.indexOf('storage'));
  });
});

/**
 * 🟥 Answering the questions honestly must not make the plan worse than
 * refusing to answer them.
 *
 * Found by audit 2026-08-28. `dont_know` scored the full `stated` weight, so a
 * person who clicked "Skip all" — which sends `dont_know` for every unanswered
 * area — pushed the ONE area with visible evidence to the bottom of the plan,
 * beneath three shrugs. Measured on Pagila; the ⑤ block in the source has the
 * before and after.
 */
describe('a shrug is not a statement', () => {
  const AT = '2026-08-28T00:00:00.000Z';

  /** Pagila's shape, roughly: something payment-ish visible, nothing else. */
  const SEEN: SchemaShape = {
    schemas: ['public'],
    tables: [{ schema: 'public', table: 'users' }],
    columns: [{ schema: 'public', table: 'users', name: 'stripe_customer_id' }],
  };

  function planAfter(said: readonly StatedAnswer[]) {
    return scanPlanFrom(reconcile(emptyProfile('fp', AT), said, observeAreas(SEEN, AT), AT));
  }

  it('🟥 "I do not know" never outranks something the scan can see', () => {
    const skipAll = PROFILE_AREAS.map((area) => ({
      area,
      answer: 'dont_know' as const,
      picked: [],
    }));
    const order = planAfter(skipAll).order;
    const shrugged = PROFILE_AREAS.filter((a) => a !== 'payment');
    for (const area of shrugged) {
      assert.ok(
        order.indexOf('payment') < order.indexOf(area),
        `${area} was ranked above the only area with evidence`,
      );
    }
  });

  it('🟥 skipping the interview gives the same order as never opening it', () => {
    // The sharpest form of the bug: answering made things worse than silence.
    const skipAll = PROFILE_AREAS.map((area) => ({
      area,
      answer: 'dont_know' as const,
      picked: [],
    }));
    assert.deepEqual(planAfter(skipAll).order, planAfter([]).order);
  });

  it('🟥 and it is never told back to them as "you told me about this"', () => {
    const plan = planAfter([{ area: 'jobs', answer: 'dont_know', picked: [] }]);
    assert.ok(!/you told me/.test(plan.because.jobs));
    assert.ok(/not sure/.test(plan.because.jobs));
  });

  it('an actual yes still outranks an area nobody mentioned', () => {
    // The weight had to drop for `dont_know` alone. A person saying "yes, we
    // run cron jobs" is a real statement and still earns its place.
    const plan = planAfter([{ area: 'jobs', answer: 'yes', picked: ['pg_cron'] }]);
    assert.ok(plan.order.indexOf('jobs') < plan.order.indexOf('storage'));
    assert.equal(plan.because.jobs, 'you told me about this');
  });
});

/**
 * 🟥 "No" is the clearest instruction in the whole profile, and nothing was
 * checking that the plan listened to it.
 *
 * Found by audit 2026-08-28 with a mutation: deleting the `no` clause left
 * every test green while genuinely changing the order a scan runs in. The
 * comment beside the code explained the rule at length and no test held it.
 */
describe('an area somebody ruled out', () => {
  const AT = '2026-08-28T00:00:00.000Z';
  const NOTHING: SchemaShape = { schemas: ['public'], tables: [], columns: [] };

  function planAfter(said: readonly StatedAnswer[]) {
    return scanPlanFrom(reconcile(emptyProfile('fp', AT), said, observeAreas(NOTHING, AT), AT));
  }

  it('🟥 does not get looked at before an area nobody has mentioned', () => {
    // The mutation that survived: without the clause, `no` scores the `stated`
    // weight and a person's clearest instruction PROMOTES the area instead.
    const plan = planAfter([{ area: 'jobs', answer: 'no', picked: [] }]);
    for (const area of PROFILE_AREAS) {
      if (area === 'jobs') continue;
      assert.ok(
        plan.order.indexOf(area) < plan.order.indexOf('jobs'),
        `jobs was ranked above ${area} despite being ruled out`,
      );
    }
  });

  it('🟥 ranks below "I do not know", which is not the same answer', () => {
    // Both score zero, and ties keep declaration order — so this is pinned by
    // making `no` come from the EARLIER area, where a tie would put it first.
    const plan = planAfter([
      { area: 'auth', answer: 'no', picked: [] },
      { area: 'jobs', answer: 'dont_know', picked: [] },
    ]);
    assert.ok(plan.order.indexOf('jobs') < plan.order.indexOf('auth'));
  });

  it('is told back to them in their own terms', () => {
    assert.equal(
      planAfter([{ area: 'jobs', answer: 'no', picked: [] }]).because.jobs,
      'you said this is not part of your system',
    );
  });

  it('is still in the plan, at the end, rather than removed from it', () => {
    // §25: the plan decides ORDER, never WHETHER. An area dropped entirely is
    // one nobody can be told was skipped.
    const plan = planAfter([{ area: 'jobs', answer: 'no', picked: [] }]);
    assert.equal(plan.order.length, PROFILE_AREAS.length);
    assert.ok(plan.order.includes('jobs'));
  });
});

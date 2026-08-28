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
import type { ProjectProfile } from '../src/index.js';

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

  it('🟥 "no" earns nothing — it is an instruction, not interest', () => {
    // Promoting an area for having been mentioned would read every answer as
    // engagement, including the one that says "this is not part of my system".
    const saidNo = withArea('auth', { state: 'stated', answer: 'no', picked: [] });
    const order = scanPlanFrom(saidNo).order;
    assert.equal(order.indexOf('auth'), PROFILE_AREAS.indexOf('auth'));
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

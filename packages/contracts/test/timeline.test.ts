/**
 * The four rules that stop a timeline saying more than the rows support.
 *
 * Ideal §33 wants: what happened, when, where it broke, how many like it. Each
 * of those four has a way of being confidently wrong, and each test below is
 * one of them:
 *
 *   ① a step with no time, placed as though it had one
 *   ② rows never reached, reported as rows that were zero
 *   ③ "0 similar cases" printed when nobody counted
 *   ④ a table with no clock at all, and nobody saying so
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  timelineFrom,
  timelineSaysNothing,
  timelineTier,
} from '../src/timeline.js';
import type { HopResult } from '../src/timeline.js';
import type { EntityEdge } from '../src/entity-graph.js';

function edge(tier: EntityEdge['tier'] = 'declared'): EntityEdge {
  const base = {
    from: { schema: 'public', table: 'a' },
    to: { schema: 'public', table: 'b' },
    via: 'a_id',
    why: 'a declared foreign key',
  };
  const join = { from: ['a_id'], to: ['id'] };
  if (tier === 'measured') return { ...base, tier, matched: { of: 10, found: 9 }, join };
  if (tier === 'guessed') return { ...base, tier, matched: null, join: null };
  return { ...base, tier, matched: null, join };
}

function hop(over: Partial<HopResult> = {}): HopResult {
  return {
    entity: 'public.rental',
    via: 'customer_id',
    path: [edge()],
    rows: 3,
    at: '2026-08-28T10:32:14Z',
    timeColumn: 'rental_date',
    ...over,
  };
}

describe('① a step with no time keeps its route position', () => {
  it('sorts timed steps by time and leaves untimed ones where the route put them', () => {
    const timeline = timelineFrom('public.customer', [
      hop({ entity: 'public.rental', at: '2026-08-28T10:00:00Z' }),
      hop({ entity: 'public.note', at: null, timeColumn: null }),
      hop({ entity: 'public.payment', at: '2026-08-28T09:00:00Z' }),
    ], []);

    // The two timed hops swap; `note` does not slide between them, because
    // nothing measured says where it goes.
    assert.deepEqual(
      timeline.steps.map((s) => s.entity),
      ['public.payment', 'public.rental', 'public.note'],
    );
  });

  it('marks the untimed step so a renderer cannot print it as a clock reading', () => {
    const timeline = timelineFrom('public.customer', [
      hop({ entity: 'public.note', at: null, timeColumn: null }),
    ], []);
    assert.equal(timeline.steps[0]!.placedWithoutTime, true);
  });

  it('a timed step is not marked', () => {
    const timeline = timelineFrom('public.customer', [hop()], []);
    assert.equal(timeline.steps[0]!.placedWithoutTime, false);
  });
});

describe('② the break ends the walk, and what follows is unreached', () => {
  it('names where it stopped and what it stopped after', () => {
    const timeline = timelineFrom('public.customer', [
      hop({ entity: 'public.rental', rows: 2 }),
      hop({ entity: 'public.payment', rows: 0, via: 'rental_id' }),
    ], []);

    assert.ok(timeline.brokeAt);
    assert.equal(timeline.brokeAt.after, 'public.rental');
    assert.equal(timeline.brokeAt.at, 'public.payment');
    assert.equal(timeline.brokeAt.via, 'rental_id');
  });

  it('🟥 hops past the break are unreached, NOT steps with zero rows', () => {
    // The distinction the whole rule exists for. If the rental is missing then
    // "0 payments" is not a finding about payments — the question never got
    // there, and a reader shown two zeroes concludes two things are broken.
    const timeline = timelineFrom('public.customer', [
      hop({ entity: 'public.rental', rows: 0 }),
      hop({ entity: 'public.payment', rows: 0 }),
    ], []);

    assert.equal(timeline.steps.length, 0);
    assert.deepEqual([...timeline.unreached], ['public.payment']);
    assert.equal(timeline.brokeAt!.at, 'public.rental');
    assert.equal(timeline.brokeAt!.after, 'public.customer');
  });

  it('a whole route with rows breaks nowhere and leaves nothing unreached', () => {
    const timeline = timelineFrom('public.customer', [hop(), hop({ entity: 'public.payment' })], []);
    assert.equal(timeline.brokeAt, null);
    assert.deepEqual([...timeline.unreached], []);
  });

  it('a break is worth its weakest hop', () => {
    const timeline = timelineFrom('public.customer', [
      hop({ entity: 'public.payment', rows: 0, path: [edge('declared'), edge('guessed')] }),
    ], []);
    // A break across a relationship nobody declared may be no break at all —
    // only two tables that were never related.
    assert.equal(timeline.brokeAt!.tier, 'guessed');
  });
});

describe('③ similar cases are null until something counts them', () => {
  it('defaults to null, not zero', () => {
    assert.equal(timelineFrom('public.customer', [hop()], []).similar, null);
  });

  it('carries a real count through', () => {
    assert.equal(timelineFrom('public.customer', [hop()], [], 3).similar, 3);
  });

  it('carries a counted zero through, which is a different fact', () => {
    // "I counted, and this happened to nobody else" is worth saying. It must
    // not be indistinguishable from "nobody counted".
    assert.equal(timelineFrom('public.customer', [hop()], [], 0).similar, 0);
  });
});

describe('④ a table with no clock is measured, not left to the model', () => {
  it('adds the admission the model forgot', () => {
    const timeline = timelineFrom('public.customer', [
      hop({ entity: 'public.session', timeColumn: null, at: null }),
    ], []);
    assert.deepEqual([...timeline.untimed], ['public.session']);
    assert.ok(timeline.outside.includes('events_not_recorded'));
  });

  it('does not invent the admission when every table has a clock', () => {
    const timeline = timelineFrom('public.customer', [hop()], []);
    assert.deepEqual([...timeline.untimed], []);
    assert.equal(timeline.outside.includes('events_not_recorded'), false);
  });

  it('keeps what the model claimed as well, without duplicating', () => {
    const timeline = timelineFrom(
      'public.customer',
      [hop({ entity: 'public.session', timeColumn: null, at: null })],
      ['external_service', 'events_not_recorded'],
    );
    assert.deepEqual(
      [...timeline.outside].sort(),
      ['events_not_recorded', 'external_service'],
    );
  });

  it('an unreached hop with no clock still counts as untimed', () => {
    // It was still on the route the reader is being told about, and its
    // silence about time is a fact about the map rather than about the walk.
    const timeline = timelineFrom('public.customer', [
      hop({ entity: 'public.rental', rows: 0 }),
      hop({ entity: 'public.session', timeColumn: null, at: null }),
    ], []);
    assert.ok(timeline.untimed.includes('public.session'));
  });
});

describe('what the timeline refuses to imply', () => {
  it('a walk that found nothing and broke nowhere says nothing', () => {
    const timeline = timelineFrom('public.customer', [], []);
    assert.equal(timelineSaysNothing(timeline), true);
  });

  it('a walk that broke IS saying something', () => {
    const timeline = timelineFrom('public.customer', [hop({ rows: 0 })], []);
    assert.equal(timelineSaysNothing(timeline), false);
  });

  it('the whole account is worth its weakest hop, break included', () => {
    const timeline = timelineFrom('public.customer', [
      hop({ entity: 'public.rental', path: [edge('declared')] }),
      hop({ entity: 'public.payment', rows: 0, path: [edge('measured')] }),
    ], []);
    assert.equal(timelineTier(timeline), 'measured');
  });

  it('has no tier to give when it has nothing to weigh', () => {
    assert.equal(timelineTier(timelineFrom('public.customer', [], [])), null);
  });
});

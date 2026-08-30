/**
 * The map, corrected by what the scan actually counted.
 *
 * `EdgeTier` had three rungs and the product produced two. Measured on Pagila
 * before this existed: 24 declared edges, 11 guessed, **0 measured** — while
 * layer B held twelve counted verdicts, one of them
 * `damaged_external_ref.staff_id -> staff.staff_id, 0 of 30`. Zero values
 * present, and the map kept the edge.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyVerdicts } from '../src/entity-graph.js';
import type { CountedEdge, EntityEdge, EntityGraph } from '../src/entity-graph.js';

function guessed(child: string, via: string, parent: string): EntityEdge {
  return {
    from: { schema: 'public', table: child },
    to: { schema: 'public', table: parent },
    via,
    why: `the column is called "${via}" and so is a table in this schema`,
    tier: 'guessed',
    matched: null,
    join: null,
  };
}

function declared(child: string, via: string, parent: string): EntityEdge {
  return {
    from: { schema: 'public', table: child },
    to: { schema: 'public', table: parent },
    via,
    why: 'a declared foreign key',
    tier: 'declared',
    matched: null,
    join: { from: [via], to: [via] },
  };
}

function counted(
  child: string,
  via: string,
  parent: string,
  of: number,
  found: number,
): CountedEdge {
  return {
    childSchema: 'public',
    childTable: child,
    childColumn: via,
    parentSchema: 'public',
    parentTable: parent,
    parentColumn: `${parent}_id`,
    of,
    found,
    holds: found > 0 && found / of >= 0.5,
  };
}

const GRAPH: EntityGraph = {
  edges: [
    declared('rental', 'customer_id', 'customer'),
    guessed('payment', 'customer_id', 'customer'),
    guessed('damaged_external_ref', 'staff_id', 'staff'),
    guessed('nobody_counted_me', 'thing_id', 'thing'),
  ],
};

describe('counting corrects the map', () => {
  it('🟩 promotes a guess the values confirmed, and carries the count', () => {
    const out = applyVerdicts(GRAPH, [counted('payment', 'customer_id', 'customer', 51061, 51061)]);
    const edge = out.graph.edges.find((e) => e.from.table === 'payment')!;
    assert.equal(edge.tier, 'measured');
    assert.deepEqual(edge.matched, { of: 51061, found: 51061 });
    assert.equal(out.promoted, 1);
  });

  it('🟥 joins on the columns the VERDICT names, not the child column twice', () => {
    // 🟥 The first version of this asserted a pair where the child and parent
    // columns happen to share a name, so `[verdict.childColumn,
    // verdict.parentColumn]` and `[edge.via, edge.via]` produced the same
    // answer and a mutation walked straight through. A case both
    // implementations agree on tests neither — the third time this session.
    //
    // Real, from Pagila's own verdicts: `store.manager_staff_id` points at
    // `staff.staff_id`, and the two names differ. Joining on `manager_staff_id
    // = manager_staff_id` would query a column that is not there.
    const graph: EntityGraph = { edges: [guessed('store', 'manager_staff_id', 'staff')] };
    const out = applyVerdicts(graph, [
      {
        childSchema: 'public',
        childTable: 'store',
        childColumn: 'manager_staff_id',
        parentSchema: 'public',
        parentTable: 'staff',
        parentColumn: 'staff_id',
        of: 500,
        found: 500,
        holds: true,
      },
    ]);
    const edge = out.graph.edges[0]!;
    assert.equal(edge.tier, 'measured');
    assert.deepEqual(edge.join, { from: ['manager_staff_id'], to: ['staff_id'] });
    // A measured edge must be joinable at all — N58 — and that is what makes
    // the promotion worth anything: a guess has no columns, so every route
    // through one comes back `unwalkable`.
    assert.notEqual(edge.join, null);
  });

  it('🟥 REMOVES a guess the values disproved', () => {
    // The real one, from Pagila: nought of thirty. The map kept it, and G3
    // would have walked a relationship this product had already checked and
    // found not to be there.
    const out = applyVerdicts(GRAPH, [counted('damaged_external_ref', 'staff_id', 'staff', 30, 0)]);
    assert.equal(out.graph.edges.some((e) => e.from.table === 'damaged_external_ref'), false);
    assert.equal(out.dropped, 1);
  });

  it('🟥 never touches a declared edge, however the count came out', () => {
    // The catalogue is the database's own statement about itself. A count
    // that disagreed with a foreign key means the constraint is not being
    // enforced — a finding about their system, raised by layer A, and not a
    // reason for this product to quietly edit its own map.
    const out = applyVerdicts(GRAPH, [counted('rental', 'customer_id', 'customer', 100, 0)]);
    const still = out.graph.edges.find((e) => e.from.table === 'rental');
    assert.notEqual(still, undefined);
    assert.equal(still?.tier, 'declared');
    assert.equal(out.dropped, 0);
    assert.equal(out.promoted, 0);
  });

  it('leaves a guess nobody counted exactly as it was', () => {
    const out = applyVerdicts(GRAPH, [counted('payment', 'customer_id', 'customer', 10, 10)]);
    const untouched = out.graph.edges.find((e) => e.from.table === 'nobody_counted_me');
    assert.equal(untouched?.tier, 'guessed');
  });

  it('🟥 counts verdicts that landed on nothing — that number is debt N57', () => {
    // `guessedEdges` (contracts) and `findCandidates` (layer B) are two copies
    // of one naming rule. N57 recorded that they had never been seen to
    // disagree. This is where a disagreement becomes a number: on Pagila it
    // is 3.
    const out = applyVerdicts(GRAPH, [
      counted('payment', 'customer_id', 'customer', 10, 10),
      counted('table_the_map_never_guessed', 'x_id', 'x', 10, 10),
    ]);
    assert.equal(out.unmatched, 1);
    // And it does not invent an edge for it. Adding a relationship the map
    // never proposed is a bigger step than correcting one it did.
    assert.equal(out.graph.edges.some((e) => e.from.table === 'table_the_map_never_guessed'), false);
  });

  it('tells two columns of the same pair apart', () => {
    // A table can point at one parent through two columns, and they can be
    // counted differently. Keying on the pair alone would apply one verdict
    // to both.
    const two: EntityGraph = {
      edges: [guessed('payment', 'customer_id', 'customer'), guessed('payment', 'billed_to', 'customer')],
    };
    const out = applyVerdicts(two, [counted('payment', 'billed_to', 'customer', 30, 0)]);
    assert.equal(out.dropped, 1);
    assert.equal(out.graph.edges.length, 1);
    assert.equal(out.graph.edges[0]?.via, 'customer_id');
  });

  it('does nothing at all when nothing was counted', () => {
    const out = applyVerdicts(GRAPH, []);
    assert.deepEqual(out.graph.edges, GRAPH.edges);
    assert.equal(out.promoted + out.dropped + out.unmatched, 0);
  });
});

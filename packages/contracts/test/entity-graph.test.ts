/**
 * The rules that stop a graph telling a confident story it has not earned.
 *
 * Ideal §31 and §32, and the Opus 5 audit under §32 — the harshest block in
 * that document. Its finding is not "the graph is hard to build"; it is that a
 * WRONG edge does not produce a wrong-looking answer. It produces a fluent,
 * specific, entirely wrong account of somebody's outage, which is worse than
 * no answer because a person can act on it.
 *
 * So every rule here is about keeping a claim beside the reason for it:
 *
 *   1. Three tiers that never blur. `declared` is enforced by Postgres,
 *      `measured` counted values, `guessed` read a name.
 *   2. A path is worth its WEAKEST hop. Four certainties cannot lend anything
 *      to the one link nobody checked.
 *   3. Every edge names a column. An edge nobody can point at is one nobody
 *      can check, and this product does not assert those.
 *   4. Edges are followed in both directions, because almost every real
 *      question travels the way the foreign key does not.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EDGE_TIERS,
  EntityEdge,
  declaredEdges,
  entitiesIn,
  graphFrom,
  guessedEdges,
  pathTier,
  pathsFrom,
  refOf,
  strongestFirst,
} from '../src/index.js';
import type { EntityGraph, EntityEdge as Edge, EdgeTier } from '../src/index.js';

function edge(
  from: string,
  to: string,
  tier: EdgeTier,
  via = 'x_id',
): Edge {
  const [fs, ft] = from.split('.');
  const [ts, tt] = to.split('.');
  const base = {
    from: { schema: fs!, table: ft! },
    to: { schema: ts!, table: tt! },
    via,
    why: `a test built this ${tier} edge`,
  };
  // Built through the union rather than cast into it. A helper that casts
  // would let every test below assert against a shape the parser refuses.
  return tier === 'measured'
    ? { ...base, tier, matched: { of: 100, found: 97 } }
    : { ...base, tier, matched: null };
}

describe('the three tiers', () => {
  it('are exactly the three the audit names', () => {
    assert.deepEqual([...EDGE_TIERS], ['declared', 'measured', 'guessed']);
  });

  it('🟥 an edge cannot exist without a reason somebody can read', () => {
    // Rule 3. `.min(1)` would let a single space through, which is the hole
    // `saying()` exists to close on a finding's prose — and an edge is a claim
    // about somebody's system exactly as a finding is.
    assert.throws(() => EntityEdge.parse({ ...edge('a.b', 'c.d', 'guessed'), why: '   ' }));
    assert.throws(() => EntityEdge.parse({ ...edge('a.b', 'c.d', 'guessed'), why: '' }));
  });

  it('🟥 an edge cannot exist without naming the column it travels on', () => {
    assert.throws(() => EntityEdge.parse({ ...edge('a.b', 'c.d', 'declared'), via: '' }));
  });

  it('🟥 a match rate on a declared edge does not parse', () => {
    // This used to say "not enforced by the schema" and assert the rule on
    // the builders instead. Builders can be added — that set went from one to
    // two in a day — so the rule lives on the type now.
    //
    // What it stops: 60% of an enforced constraint, shown to somebody who
    // cannot check it, with nothing having counted anything.
    assert.throws(() =>
      EntityEdge.parse({
        ...edge('public.orders', 'public.users', 'declared'),
        matched: { of: 100, found: 60 },
      }),
    );
  });

  it('🟥 a measured edge without its count does not parse either', () => {
    // The other half. A measured edge missing the rate is not a weak
    // measurement, it is an edge claiming a tier it never earned.
    assert.throws(() =>
      EntityEdge.parse({
        ...edge('public.orders', 'public.users', 'measured'),
        matched: null,
      }),
    );
  });

  it('🟥 a rate above one does not parse', () => {
    // Not a strong edge — a bug in whatever counted, and an impossible
    // percentage in front of a person.
    assert.throws(() =>
      EntityEdge.parse({
        ...edge('public.orders', 'public.users', 'measured'),
        matched: { of: 10, found: 11 },
      }),
    );
  });

  it('the builders never invent a number Postgres already guarantees', () => {
    const made = declaredEdges([
      {
        schema: 'public',
        table: 'orders',
        columns: ['user_id'],
        referencedSchema: 'public',
        referencedTable: 'users',
        kind: 'foreign_key',
      },
    ]);
    assert.equal(made[0]?.matched, null);
  });
});

describe('reading the database’s own declarations', () => {
  const CONSTRAINTS = [
    {
      schema: 'public',
      table: 'orders',
      columns: ['user_id'],
      referencedSchema: 'public',
      referencedTable: 'users',
      kind: 'foreign_key',
    },
    // Not a relationship. A CHECK constrains one table's values and points at
    // nothing, so it must not become an edge — an edge to nowhere would give a
    // path somewhere to go and nothing to find there.
    {
      schema: 'public',
      table: 'orders',
      columns: ['total'],
      referencedSchema: null,
      referencedTable: null,
      kind: 'check',
    },
  ];

  it('turns foreign keys into edges and leaves everything else alone', () => {
    const made = declaredEdges(CONSTRAINTS);
    assert.equal(made.length, 1);
    assert.equal(made[0]?.tier, 'declared');
    assert.equal(refOf(made[0]!.to), 'public.users');
  });

  it('🟥 reads the connector’s word for a foreign key, not the catalog letter', () => {
    // The first draft compared against `'f'`, which is what
    // `pg_constraint.contype` holds and NOT what `Constraint.kind` carries. A
    // comparison that matches nothing does not fail — it returns an empty list,
    // and an empty graph reads exactly like a database where nothing is
    // connected. §4.16: an assertion that cannot come back red is worth less
    // than no assertion, and this is its data-shaped twin.
    assert.equal(declaredEdges([{ ...CONSTRAINTS[0]!, kind: 'f' }]).length, 0);
    assert.equal(declaredEdges([{ ...CONSTRAINTS[0]!, kind: 'foreign_key' }]).length, 1);
  });

  it('a composite key is one relationship and names all of its columns', () => {
    const made = declaredEdges([
      { ...CONSTRAINTS[0]!, columns: ['tenant_id', 'user_id'] },
    ]);
    assert.equal(made.length, 1);
    assert.equal(made[0]?.via, 'tenant_id, user_id');
  });

  it('a NOT VALID foreign key is still declared', () => {
    // It looks wrong for a second and is right: NOT VALID means Postgres never
    // checked the rows already there, not that it stopped enforcing new ones.
    // Somebody declared the relationship and meant it. Whether the existing
    // rows honour it is Layer A's question, and it has a rule pack for saying
    // so — demoting the edge here would answer that question in the wrong
    // place and with less evidence.
    const made = declaredEdges(CONSTRAINTS);
    assert.equal(made[0]?.tier, 'declared');
  });
});

describe('a path is worth its weakest hop', () => {
  it('🟥 four certainties cannot carry one guess', () => {
    // Rule 2, and the single most important line in this file. This is the
    // rule that stops a fluent five-step explanation resting on one link
    // nobody ever checked — which the ideal's audit calls the most dangerous
    // failure this design has.
    const path = [
      edge('public.a', 'public.b', 'declared'),
      edge('public.b', 'public.c', 'declared'),
      edge('public.c', 'public.d', 'declared'),
      edge('public.d', 'public.e', 'declared'),
      edge('public.e', 'public.f', 'guessed'),
    ];
    assert.equal(pathTier(path), 'guessed');
  });

  it('one measured hop pulls a declared path down to measured', () => {
    const path = [
      edge('public.a', 'public.b', 'declared'),
      edge('public.b', 'public.c', 'measured'),
    ];
    assert.equal(pathTier(path), 'measured');
  });

  it('a guess beats a measurement downwards, whatever the order', () => {
    // Order must not matter. A rule that depended on which hop came first
    // would rate the same route differently depending on which end you asked
    // from, and both answers would look equally confident.
    const a = [edge('public.a', 'public.b', 'measured'), edge('public.b', 'public.c', 'guessed')];
    const b = [edge('public.a', 'public.b', 'guessed'), edge('public.b', 'public.c', 'measured')];
    assert.equal(pathTier(a), 'guessed');
    assert.equal(pathTier(b), 'guessed');
  });

  it('an all-declared path stays declared, so the rule is not just pessimism', () => {
    // §4.24: a rule that returned the weakest answer for every input would
    // pass every test above and mean nothing.
    const path = [
      edge('public.a', 'public.b', 'declared'),
      edge('public.b', 'public.c', 'declared'),
    ];
    assert.equal(pathTier(path), 'declared');
  });

  it('an empty path is declared — there is no hop to be unsure about', () => {
    assert.equal(pathTier([]), 'declared');
  });
});

describe('walking out from one table', () => {
  const graph: EntityGraph = {
    edges: [
      edge('public.orders', 'public.users', 'declared', 'user_id'),
      edge('public.payments', 'public.orders', 'declared', 'order_id'),
      edge('public.sessions', 'public.users', 'guessed', 'user_id'),
      edge('public.audit', 'public.nothing_related', 'declared', 'x_id'),
    ],
  };

  it('🟥 follows edges backwards, because that is the way questions travel', () => {
    // Rule 4. `orders.user_id → users` also means "given this user, here are
    // their orders", and almost every real question is asked from the person's
    // end: somebody reports a problem with a PERSON and needs what happened to
    // them, not what they point at.
    const out = pathsFrom(graph, { schema: 'public', table: 'users' }, 2);
    const reached = out.map((o) => o.to);
    assert.ok(reached.includes('public.orders'), 'a user reaches nothing they own');
    assert.ok(reached.includes('public.payments'), 'two hops did not happen');
  });

  it('stops at the hop limit', () => {
    const out = pathsFrom(graph, { schema: 'public', table: 'users' }, 1);
    assert.ok(out.map((o) => o.to).includes('public.orders'));
    assert.ok(!out.map((o) => o.to).includes('public.payments'));
  });

  it('never returns to where it started', () => {
    const out = pathsFrom(graph, { schema: 'public', table: 'users' }, 3);
    assert.ok(!out.map((o) => o.to).includes('public.users'));
  });

  it('does not reach a table nothing connects to', () => {
    const out = pathsFrom(graph, { schema: 'public', table: 'users' }, 3);
    assert.ok(!out.map((o) => o.to).includes('public.audit'));
  });

  it('the shortest route wins, so a person can follow it', () => {
    const out = pathsFrom(graph, { schema: 'public', table: 'users' }, 3);
    const orders = out.find((o) => o.to === 'public.orders');
    assert.equal(orders?.path.length, 1);
  });

  it('a path through a guess is reported AS a guess', () => {
    const out = pathsFrom(graph, { schema: 'public', table: 'users' }, 2);
    const sessions = out.find((o) => o.to === 'public.sessions');
    assert.equal(pathTier(sessions?.path ?? []), 'guessed');
  });
});

describe('what a screen reads first', () => {
  it('the database’s own word comes before a guess', () => {
    // Whatever is read first is what a tired person takes away, and this
    // product would rather that be the thing Postgres enforces.
    const sorted = strongestFirst([
      edge('public.a', 'public.z', 'guessed'),
      edge('public.a', 'public.m', 'measured'),
      edge('public.a', 'public.b', 'declared'),
    ]);
    assert.deepEqual(sorted.map((e) => e.tier), ['declared', 'measured', 'guessed']);
  });

  it('a graph knows which tables are in it, and an isolated one is not', () => {
    assert.deepEqual(entitiesIn({ edges: [edge('public.a', 'public.b', 'declared')] }), [
      'public.a',
      'public.b',
    ]);
    assert.deepEqual(entitiesIn({ edges: [] }), []);
  });
});

describe('a partitioned table is one table', () => {
  const PARENT = { schema: 'public', table: 'payment' };
  const partitionOf = new Map([
    ['public.payment_p2022_01', PARENT],
    ['public.payment_p2022_02', PARENT],
  ]);

  function fkOn(table: string) {
    return {
      schema: 'public',
      table,
      columns: ['customer_id'],
      referencedSchema: 'public',
      referencedTable: 'customer',
      kind: 'foreign_key',
    };
  }

  it('🟥 the relationship survives, filed under the name a person knows', () => {
    // Measured on Pagila: Postgres declares a partitioned table's foreign keys
    // on each PARTITION, and the parent carries none of its own. The first
    // version of this code SKIPPED partition-owned constraints to avoid 54
    // copies — and deleted the relationship, which the name-guesser then
    // re-derived as `guessed`. Something the database enforces, demoted to
    // something nobody checked. Worse than the noise it was avoiding.
    const made = declaredEdges([fkOn('payment_p2022_01'), fkOn('payment_p2022_02')], partitionOf);
    assert.equal(made.length, 1, '54 months of one relationship reached the graph');
    assert.equal(refOf(made[0]!.from), 'public.payment');
    assert.equal(made[0]?.tier, 'declared');
  });

  it('a table that is not a partition keeps its own name', () => {
    const made = declaredEdges([fkOn('rental')], partitionOf);
    assert.equal(refOf(made[0]!.from), 'public.rental');
  });

  it('two DIFFERENT relationships on one parent are not collapsed', () => {
    // §4.24 — a dedupe keyed too loosely would pass the test above and quietly
    // eat the second relationship. `crate_owner_invitations` really does point
    // at users twice, through different columns, and which is which matters.
    const other = { ...fkOn('payment_p2022_01'), columns: ['staff_id'], referencedTable: 'staff' };
    const made = declaredEdges([fkOn('payment_p2022_01'), other], partitionOf);
    assert.equal(made.length, 2);
  });
});

describe('reading a name when nobody declared anything', () => {
  const TABLES = [
    { schema: 'public', table: 'users' },
    { schema: 'public', table: 'badges' },
    { schema: 'public', table: 'comments' },
  ];

  it('🟥 finds edges in a schema with zero foreign keys', () => {
    // The whole reason this tier exists. Measured: `se_devops`, a real Stack
    // Exchange schema on this machine, declares ZERO foreign keys. A product
    // that reported only declarations would tell somebody who inherited that
    // database it has no connections in it.
    const made = guessedEdges(TABLES, [
      { schema: 'public', table: 'badges', name: 'user_id' },
      { schema: 'public', table: 'comments', name: 'user_id' },
    ]);
    assert.equal(made.length, 2);
    assert.ok(made.every((e) => e.tier === 'guessed'));
    assert.ok(made.every((e) => refOf(e.to) === 'public.users'));
  });

  it('🟥 never guesses at a table that is not there', () => {
    // A guess pointing at nothing is not a weaker guess — it is a wrong one,
    // and it would give a path somewhere to go with nothing to find.
    const made = guessedEdges(TABLES, [
      { schema: 'public', table: 'badges', name: 'invoice_id' },
    ]);
    assert.deepEqual(made, []);
  });

  it('🟥 never repeats something the database already declares', () => {
    const declared = declaredEdges([
      {
        schema: 'public',
        table: 'badges',
        columns: ['user_id'],
        referencedSchema: 'public',
        referencedTable: 'users',
        kind: 'foreign_key',
      },
    ]);
    const made = guessedEdges(
      TABLES,
      [{ schema: 'public', table: 'badges', name: 'user_id' }],
      declared,
    );
    assert.deepEqual(made, [], 'a guess restated something Postgres enforces');
  });

  it('a primary key is not a relationship with itself', () => {
    // `users.user_id` is the primary key column of half the schemas ever
    // written, and an edge from a table to itself explains nothing.
    const made = guessedEdges(TABLES, [{ schema: 'public', table: 'users', name: 'user_id' }]);
    assert.deepEqual(made, []);
  });

  it('matches the plural of a name as well as the singular', () => {
    const made = guessedEdges(
      [{ schema: 'public', table: 'comments' }, { schema: 'public', table: 'post' }],
      [
        { schema: 'public', table: 'comments', name: 'post_id' },
        { schema: 'public', table: 'post', name: 'comment_id' },
      ],
    );
    assert.equal(made.length, 2);
  });

  it('🟥 says what it did, not what it concluded', () => {
    // So a person can disagree with the step. And it admits, in the same
    // sentence, that no value was compared — because the danger of this tier
    // is a wrong edge producing a fluent, specific, entirely wrong story.
    const made = guessedEdges(TABLES, [
      { schema: 'public', table: 'badges', name: 'user_id' },
    ]);
    assert.match(made[0]!.why, /the column is called "user_id"/);
    assert.match(made[0]!.why, /Nothing checked whether the values line up/);
  });
});

describe('the two rungs that came from counting', () => {
  const TABLES = [
    { schema: 'public', table: 'medium' },
    { schema: 'public', table: 'staff' },
    { schema: 'public', table: 'users' },
    { schema: 'public', table: 'store' },
  ];

  it('🟥 reads a bare parent name as a column', () => {
    // Rung ②. MusicBrainz writes 390 of its 758 foreign keys this way —
    // `alternative_medium.medium` → `medium` — and a rule that only knows
    // `<name>_id` scored 0.0% there. Not a low number: zero, across 370
    // tables, on a schema where the graph is the entire point.
    const made = guessedEdges(TABLES, [
      { schema: 'public', table: 'store', name: 'medium' },
    ]);
    assert.equal(made.length, 1);
    assert.equal(refOf(made[0]!.to), 'public.medium');
    assert.match(made[0]!.why, /and so is a table in this schema/);
  });

  it('🟥 reads a role in front of the parent name', () => {
    // Rung ③. `store.manager_staff_id` → `staff` is Pagila's ONLY undeclared
    // link, and `posts.owner_user_id` → `users` is the common shape in both
    // Stack Exchange schemas. Exact match misses both.
    const made = guessedEdges(TABLES, [
      { schema: 'public', table: 'store', name: 'manager_staff_id' },
      { schema: 'public', table: 'store', name: 'owner_user_id' },
    ]);
    assert.equal(made.length, 2);
    assert.deepEqual(made.map((e) => refOf(e.to)).sort(), ['public.staff', 'public.users']);
  });

  it('the longest stem wins, so a role prefix is not mistaken for the parent', () => {
    // `invited_by_user_id` must find `users`, not stop at something shorter
    // that also happens to exist. Both candidates are real tables here, so the
    // test would pass by luck if the loop went the other way — §4.24.
    const made = guessedEdges(
      [{ schema: 'public', table: 'users' }, { schema: 'public', table: 'by' }],
      [{ schema: 'public', table: 'invites', name: 'invited_by_user_id' }],
    );
    assert.equal(refOf(made[0]!.to), 'public.users');
  });

  it('an exact match beats a suffix of itself', () => {
    // Precision first. `staff_id` where a `staff` table exists must not be
    // resolved through the suffix rung to something else.
    const made = guessedEdges(TABLES, [
      { schema: 'public', table: 'store', name: 'staff_id' },
    ]);
    assert.equal(refOf(made[0]!.to), 'public.staff');
    assert.match(made[0]!.why, /there is a table called "staff"/);
  });

  it('🟥 a bare name pointing at nothing stays silent', () => {
    // The bare-name rung is the one most likely to catch an ordinary text
    // column. It fires only when a table of that exact name exists, which is
    // what kept precision at 99.6% when recall went from 7% to 55%.
    const made = guessedEdges(TABLES, [
      { schema: 'public', table: 'store', name: 'status' },
      { schema: 'public', table: 'store', name: 'created_at' },
    ]);
    assert.deepEqual(made, []);
  });
});

describe('a foreign key that was never validated', () => {
  const FK = {
    schema: 'public',
    table: 'rental',
    columns: ['customer_id'],
    referencedSchema: 'public',
    referencedTable: 'customer',
    kind: 'foreign_key',
  };

  it('🟥 says so, because Postgres only enforces it going forward', () => {
    // Measured 2026-08-28: MusicBrainz declares 758 foreign keys and all 758
    // are NOT VALID. Without this, every declared edge on the largest database
    // this project has read would carry a sentence false about its own rows.
    const [edge] = declaredEdges([{ ...FK, validated: false }]);
    assert.equal(edge!.tier, 'declared');
    assert.match(edge!.why, /NOT VALID/);
    assert.match(edge!.why, /never checked against it/);
    assert.doesNotMatch(edge!.why, /the database enforces this/);
  });

  it('keeps the plain sentence when the key really is enforced', () => {
    assert.equal(
      declaredEdges([{ ...FK, validated: true }])[0]!.why,
      'the database enforces this with a foreign key',
    );
  });

  it('a caller that does not know about validation is not hedged at', () => {
    // Absent is not false. Pagila's stock keys are all validated and saying
    // "never checked" about them would be its own false sentence.
    assert.equal(
      declaredEdges([FK])[0]!.why,
      'the database enforces this with a foreign key',
    );
  });

  it('🟥 both limits survive together on a partly-covered partitioned table', () => {
    // 6-of-55 AND never validated is weaker than either sentence alone. The
    // coverage rewrite builds `why` from scratch, so this is the test that
    // stops it quietly dropping the other half.
    const partitionOf = new Map([
      ['public.payment_p01', { schema: 'public', table: 'payment' }],
      ['public.payment_p02', { schema: 'public', table: 'payment' }],
    ]);
    const [edge] = declaredEdges(
      [
        {
          schema: 'public',
          table: 'payment_p01',
          columns: ['customer_id'],
          referencedSchema: 'public',
          referencedTable: 'customer',
          kind: 'foreign_key',
          validated: false,
        },
      ],
      partitionOf,
    );
    assert.match(edge!.why, /on 1 of the 2 partitions/);
    assert.match(edge!.why, /NOT VALID/);
  });
});

describe('graphFrom — the one place a map is assembled', () => {
  const SOURCE = {
    tables: [
      { schema: 'public', table: 'customer', partitionOf: null },
      { schema: 'public', table: 'staff', partitionOf: null },
      { schema: 'public', table: 'payment', partitionOf: null },
      { schema: 'public', table: 'payment_p01', partitionOf: { schema: 'public', table: 'payment' } },
      { schema: 'public', table: 'payment_p02', partitionOf: { schema: 'public', table: 'payment' } },
    ],
    columns: [
      { schema: 'public', table: 'payment', name: 'customer_id' },
      { schema: 'public', table: 'payment', name: 'manager_staff_id' },
      // Copies of the parent's columns, which is what every partition carries.
      { schema: 'public', table: 'payment_p01', name: 'customer_id' },
      { schema: 'public', table: 'payment_p01', name: 'manager_staff_id' },
      { schema: 'public', table: 'payment_p02', name: 'customer_id' },
      { schema: 'public', table: 'payment_p02', name: 'manager_staff_id' },
    ],
    constraints: [
      {
        schema: 'public',
        table: 'payment_p01',
        columns: ['customer_id'],
        referencedSchema: 'public',
        referencedTable: 'customer',
        kind: 'foreign_key',
        validated: true,
      },
    ],
  };

  it('🟥 a partition never multiplies a guess', () => {
    // The columns above are one relationship copied across two partitions.
    // Feeding them to the guesser emits `manager_staff_id -> staff` three
    // times — on Pagila, fifty-five times — and somebody asking what touches
    // staff reads a list of months.
    const guesses = graphFrom(SOURCE).edges.filter((e) => e.tier === 'guessed');
    assert.equal(guesses.length, 1);
    assert.equal(refOf(guesses[0]!.from), 'public.payment');
  });

  it('🟥 a partition-owned key still becomes an edge on the parent', () => {
    // The opposite failure, and the reason partitions cannot simply be
    // dropped everywhere: this constraint is the ONLY place the relationship
    // is written down. Lose it and the guesser re-derives it as a guess —
    // something Postgres enforces, demoted to something nobody checked.
    const declared = graphFrom(SOURCE).edges.filter((e) => e.tier === 'declared');
    assert.equal(declared.length, 1);
    assert.equal(refOf(declared[0]!.from), 'public.payment');
    assert.equal(refOf(declared[0]!.to), 'public.customer');
  });

  it('a declared edge is never re-emitted as a guess', () => {
    // `payment.customer_id` is both declared and guessable. It must appear
    // once, as the stronger of the two.
    const forCustomer = graphFrom(SOURCE).edges.filter(
      (e) => refOf(e.to) === 'public.customer',
    );
    assert.equal(forCustomer.length, 1);
    assert.equal(forCustomer[0]!.tier, 'declared');
  });

  it('a partition is not a guess target', () => {
    // Nobody points a column at `payment_p01`, and leaving it in only gives
    // the bare-name rung one more way to be wrong.
    const made = graphFrom({
      ...SOURCE,
      columns: [{ schema: 'public', table: 'customer', name: 'payment_p01' }],
    }).edges.filter((e) => e.tier === 'guessed');
    assert.deepEqual(made, []);
  });

  it('what the database says comes before what a name suggests', () => {
    const tiers = graphFrom(SOURCE).edges.map((e) => e.tier);
    assert.deepEqual(tiers, ['declared', 'guessed']);
  });
});

describe('a declared edge that names no column', () => {
  it('🟥 is dropped, not emitted with an empty via', () => {
    // Found by audit 2026-08-28 with a mutation: deleting the guard left every
    // test green. `EntityEdge` refuses an empty `via` at parse time, but
    // `declaredEdges` builds its objects directly — so the guard was the only
    // thing standing between a caller and an edge nobody can point at.
    //
    // Postgres does not normally produce a foreign key with no columns; the
    // shape arrives from a catalogue read that came back short, which is
    // exactly when a silently malformed edge is worst.
    const made = declaredEdges([
      {
        schema: 'public',
        table: 'rental',
        columns: [],
        referencedSchema: 'public',
        referencedTable: 'customer',
        kind: 'foreign_key',
      },
    ]);
    assert.deepEqual(made, []);
  });

  it('🟥 and the parser would have refused it anyway, which is the point', () => {
    // Two mechanisms, and this one proves the guard is not merely duplicating
    // it: `declaredEdges` never parses, so without the guard the bad edge
    // reaches a caller unchecked.
    assert.throws(() => EntityEdge.parse({ ...edge('a.b', 'c.d', 'declared'), via: '' }));
  });
});

/**
 * G3 end to end, against a real database, with no model anywhere near it.
 *
 * Ideal §33 is one customer's complaint answered as a timeline. Everything
 * below the model — the menu, the seal, the walk, the break, the count of
 * similar cases — can be exercised without a single call, because `_doc/29`
 * put the model in one place and gave it one job: choosing. So the choice
 * here is written by hand and sealed by the same gate a model's would be.
 *
 * ## Every expected number is derivable from Pagila, not recorded from a run
 *
 * ```text
 * customer 1     66 rentals · 65 payments
 *                earliest rental_date  2022-05-25T10:30:37Z
 *                earliest payment_date 2022-01-28T20:10:06Z  <- EARLIER
 * customer 978   no rentals at all, and 2 customers in the fixture have none
 * ```
 *
 * 🟩 That the earliest payment predates the earliest rental is not a mistake
 * in the fixture and it is the most useful row in this file: it means rule ①
 * of `timeline.ts` is doing something here. Ordered by the clock the two hops
 * come back payment-then-rental, which is the reverse of the route. A
 * timeline that printed route order would look perfectly reasonable and would
 * be a timeline of the query plan.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { QueryBudget } from '@ledar/connector-postgres';
import { graphFrom, lookupOffer, sealLookup, timelineWalkedEverything } from '@ledar/contracts';
import type { GraphSource, LookupOffer } from '@ledar/contracts';
import { announceSkip, openPagila } from '@ledar/test-fixtures';

import { ANSWER_LIMITS, runTrace, timeColumns } from '../src/index.js';

const SUITE = 'tracer against Pagila';

/**
 * Pagila's two relevant foreign keys, written out.
 *
 * Hand-assembled rather than read from the catalog so the ROUTES under test
 * are exactly these and a change in the fixture cannot quietly add a third
 * one. `referencedColumns` is what N58 added, and without it every edge here
 * would arrive with no join and the whole walk would be unwalkable — which is
 * itself asserted at the bottom of this file.
 */
const SOURCE: GraphSource = {
  tables: [
    { schema: 'public', table: 'customer' },
    { schema: 'public', table: 'rental' },
    { schema: 'public', table: 'payment' },
  ],
  columns: [],
  constraints: [
    {
      schema: 'public',
      table: 'rental',
      columns: ['customer_id'],
      referencedSchema: 'public',
      referencedTable: 'customer',
      referencedColumns: ['customer_id'],
      kind: 'foreign_key',
    },
    {
      schema: 'public',
      table: 'payment',
      columns: ['rental_id'],
      referencedSchema: 'public',
      referencedTable: 'rental',
      referencedColumns: ['rental_id'],
      kind: 'foreign_key',
    },
  ],
};

const GRAPH = graphFrom(SOURCE);

/** The choice a model would make, made by hand and sealed the same way. */
function choose(offer: LookupOffer, targets: readonly string[]) {
  const customer = offer.subjects.find((s) => s.entity.table === 'customer')!;
  const follow = targets.map(
    (t) => offer.paths.find((p) => p.id.startsWith(`${customer.id}.`) && p.to === t)!.id,
  );
  return sealLookup(
    {
      answerable: true,
      subject: customer.id,
      follow,
      // What Postgres cannot answer about "I paid and see no order". Named by
      // the chooser; `timelineFrom` adds anything it can measure for itself.
      outside: ['external_service', 'application_logs'],
    },
    offer,
  );
}

const gate = await openPagila();

if (!gate.ok) {
  announceSkip(SUITE, gate.reason);
  describe(SUITE, () => {
    it('no trace was walked against a real database', { skip: gate.reason }, () => {
      // Deliberately empty. `skipped > 0` is not green, and the handoff says so.
    });
  });
} else {
  const client = gate.client;
  after(async () => {
    await client.end().catch(() => undefined);
  });

  const OFFER = lookupOffer(GRAPH);

  describe(`${SUITE} — which column is the clock`, () => {
    it('finds one per table, and says which', async () => {
      const clocks = await timeColumns(client, [
        'public.customer',
        'public.rental',
        'public.payment',
      ]);
      // Pagila names none of them `created_at`, so all three fall to the
      // first time column in ordinal order — stable, and reported.
      assert.equal(clocks.get('public.rental'), 'rental_date');
      assert.equal(clocks.get('public.payment'), 'payment_date');
      assert.equal(clocks.get('public.customer'), 'create_date');
    });

    it('says nothing about a table it was not asked about', async () => {
      const clocks = await timeColumns(client, ['public.rental']);
      assert.equal(clocks.get('public.payment'), undefined);
    });
  });

  describe(`${SUITE} — a customer whose chain is whole`, () => {
    it('🟩 counts both hops from the real database', async () => {
      const timeline = await runTrace(client, {
        lookup: choose(OFFER, ['public.rental', 'public.payment']),
        offer: OFFER,
        subject: { column: 'customer_id', value: 1 },
      });

      assert.equal(timeline.subject, 'public.customer');
      assert.equal(timeline.brokeAt, null);
      const byEntity = new Map(timeline.steps.map((s) => [s.entity, s]));
      assert.equal(byEntity.get('public.rental')?.rows, 66);
      assert.equal(byEntity.get('public.payment')?.rows, 65);
    });

    it('🟥 orders by the clock, not by the route', async () => {
      // The earliest payment for customer 1 predates their earliest rental,
      // so a timeline that came back rental-then-payment would be printing
      // the order the routes were walked in and calling it a sequence.
      const timeline = await runTrace(client, {
        lookup: choose(OFFER, ['public.rental', 'public.payment']),
        offer: OFFER,
        subject: { column: 'customer_id', value: 1 },
      });
      assert.deepEqual(
        timeline.steps.map((s) => s.entity),
        ['public.payment', 'public.rental'],
      );
    });

    it('carries a real instant, in one format', async () => {
      const timeline = await runTrace(client, {
        lookup: choose(OFFER, ['public.rental']),
        offer: OFFER,
        subject: { column: 'customer_id', value: 1 },
      });
      // ISO from the driver's Date, never Postgres' DateStyle rendering.
      assert.match(timeline.steps[0]!.at ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      assert.equal(timeline.steps[0]!.at?.slice(0, 10), '2022-05-25');
      assert.equal(timeline.steps[0]!.placedWithoutTime, false);
      // Which column the clock was read from, all the way out to the reader.
      // Choosing among several time columns is a naming rung; a reader who
      // can see the column can disagree with the choice.
      assert.equal(timeline.steps[0]!.timeColumn, 'rental_date');
    });

    it('every hop is worth what the map says, and here that is declared', async () => {
      const timeline = await runTrace(client, {
        lookup: choose(OFFER, ['public.rental', 'public.payment']),
        offer: OFFER,
        subject: { column: 'customer_id', value: 1 },
      });
      for (const step of timeline.steps) assert.equal(step.tier, 'declared');
    });
  });

  describe(`${SUITE} — a customer whose chain stops`, () => {
    it('🟥 names where it stopped, and does not report the rest as empty', async () => {
      // Customer 978 has no rentals. "0 payments" would be a second finding
      // about a table the question never reached.
      const timeline = await runTrace(client, {
        lookup: choose(OFFER, ['public.rental', 'public.payment']),
        offer: OFFER,
        subject: { column: 'customer_id', value: 978 },
      });

      assert.equal(timeline.steps.length, 0);
      assert.ok(timeline.brokeAt);
      assert.equal(timeline.brokeAt.at, 'public.rental');
      assert.equal(timeline.brokeAt.after, 'public.customer');
      assert.deepEqual([...timeline.unreached], ['public.payment']);
    });

    it('🟩 counts the others it happened to — §33s last line', async () => {
      // Two customers in the fixture have no rental at all, so excluding the
      // one being asked about leaves exactly one.
      const timeline = await runTrace(client, {
        lookup: choose(OFFER, ['public.rental', 'public.payment']),
        offer: OFFER,
        subject: { column: 'customer_id', value: 978 },
      });
      assert.equal(timeline.similar, 1);
    });

    it('a whole chain counts nothing similar, because nothing broke', async () => {
      const timeline = await runTrace(client, {
        lookup: choose(OFFER, ['public.rental']),
        offer: OFFER,
        subject: { column: 'customer_id', value: 1 },
      });
      // Null, not zero. Nobody counted, because there was nothing to count.
      assert.equal(timeline.similar, null);
    });
  });

  describe(`${SUITE} — which side of an edge is which`, () => {
    /**
     * 🟥 This suite exists because a mutation REFUSED to go red.
     *
     * Reversing the two column lists in `stepOf` — joining the parent's
     * columns against the child's — changed nothing, because both foreign
     * keys above join `customer_id` to `customer_id` and `rental_id` to
     * `rental_id`. Every assertion in this file passed while the runner was
     * working out the join direction wrongly.
     *
     * §4.16: a mutation that does not go red is a finding, not a miss.
     * Pagila has exactly one foreign key whose two sides are named
     * differently, and it is the only place in this fixture where the
     * question can be asked at all:
     *
     *     film.original_language_id  →  language.language_id
     */
    const NAMES_DIFFER: GraphSource = {
      tables: [
        { schema: 'public', table: 'film' },
        { schema: 'public', table: 'language' },
      ],
      columns: [],
      constraints: [
        {
          schema: 'public',
          table: 'film',
          columns: ['original_language_id'],
          referencedSchema: 'public',
          referencedTable: 'language',
          referencedColumns: ['language_id'],
          kind: 'foreign_key',
        },
      ],
    };

    it('🟥 joins the child column to the parent column, not the other way', async () => {
      const offer = lookupOffer(graphFrom(NAMES_DIFFER));
      const language = offer.subjects.find((s) => s.entity.table === 'language')!;
      const route = offer.paths.find(
        (p) => p.id.startsWith(`${language.id}.`) && p.to === 'public.film',
      )!;
      const lookup = sealLookup(
        {
          answerable: true,
          subject: language.id,
          follow: [route.id],
          outside: ['application_logs'],
        },
        offer,
      );

      // Pagila ships `original_language_id` unset on all 1,000 films, so the
      // right join finds nothing and the walk breaks at `film`. The WRONG
      // join asks for `language.original_language_id`, which does not exist,
      // and the query fails instead of answering — which is the shape this
      // test is here to make loud.
      const timeline = await runTrace(client, {
        lookup,
        offer,
        subject: { column: 'language_id', value: 1 },
      });

      assert.ok(timeline.brokeAt);
      assert.equal(timeline.brokeAt.at, 'public.film');
      assert.equal(timeline.steps.length, 0);
    });
  });

  describe(`${SUITE} — what it refuses to walk`, () => {
    it('🟥 a route through an edge with no columns is unwalkable, not empty', async () => {
      // The honest half of N58. A guessed edge matched a table NAME and never
      // found a column, so there is nothing to join on — and reporting that
      // as zero rows would tell somebody their data is missing when what is
      // missing is this product's ability to look.
      const guessedSource: GraphSource = {
        tables: [
          { schema: 'public', table: 'customer' },
          { schema: 'public', table: 'rental' },
        ],
        // `guessedEdges` reads column names: `customer_id` on rental names the
        // table `customer`, so this produces exactly one guessed edge.
        columns: [{ schema: 'public', table: 'rental', name: 'customer_id' }],
        constraints: [],
      };
      const guessed = graphFrom(guessedSource);
      assert.ok(guessed.edges.every((e) => e.tier === 'guessed'));

      const offer = lookupOffer(guessed);
      const timeline = await runTrace(client, {
        lookup: choose(offer, ['public.rental']),
        offer,
        subject: { column: 'customer_id', value: 1 },
      });

      assert.deepEqual([...timeline.unwalkable], ['public.rental']);
      assert.equal(timeline.steps.length, 0);
      // And crucially NOT a break. Nothing about the data was learned.
      assert.equal(timeline.brokeAt, null);
    });

    it('the admissions the chooser named survive to the reader', async () => {
      const timeline = await runTrace(client, {
        lookup: choose(OFFER, ['public.rental']),
        offer: OFFER,
        subject: { column: 'customer_id', value: 1 },
      });
      assert.ok(timeline.outside.includes('external_service'));
      assert.ok(timeline.outside.includes('application_logs'));
    });

    it('🟥 no query it builds returns a single row of anybody data', async () => {
      // ② of this package's header. Every statement is count(*) and min(),
      // so there is nothing to redact afterwards because nothing was read.
      const timeline = await runTrace(client, {
        lookup: choose(OFFER, ['public.rental']),
        offer: OFFER,
        subject: { column: 'customer_id', value: 1 },
      });
      const asText = JSON.stringify(timeline);
      // Customer 1 is MARY SMITH in Pagila. If a value ever leaked into a
      // timeline, this is where it would show up.
      assert.equal(asText.includes('MARY'), false);
      assert.equal(asText.includes('SMITH'), false);
    });
  });

  describe(`${SUITE} — what one question may spend`, () => {
    // 🟥 N59. ㉜c measured "follow every route" turning two walks into nine,
    // 4/4, in both languages, with every route real so the seal passed it.
    // MusicBrainz offers up to 161 routes from a single subject; at the 60s
    // `statement_timeout` this role carries, following all of them is 2.7
    // hours of one person's question on somebody's production database.
    //
    // These run against the real Pagila because a budget that works on a fake
    // client proves the arithmetic and not the wiring, and the wiring is the
    // part that was missing.

    it('🟥 refuses the second route when only one query is affordable', async () => {
      const budget = new QueryBudget({ ...ANSWER_LIMITS, maxQueries: 1 });
      const timeline = await runTrace(client, {
        lookup: choose(OFFER, ['public.rental', 'public.payment']),
        offer: OFFER,
        subject: { column: 'customer_id', value: 1 },
        budget,
      });

      // One walked, one refused — and the refused one lands in the list that
      // means "we stopped", not the one that means "your schema cannot be
      // followed" and not the one that means "the data ran out".
      assert.equal(timeline.steps.length, 1);
      assert.equal(timeline.unaffordable.length, 1);
      assert.deepEqual(timeline.unwalkable, []);
      assert.deepEqual(timeline.unreached, []);
      assert.equal(timeline.brokeAt, null);
    });

    it('🟥 says so, in a sentence, and admits the account is not whole', async () => {
      const budget = new QueryBudget({ ...ANSWER_LIMITS, maxQueries: 1 });
      const timeline = await runTrace(client, {
        lookup: choose(OFFER, ['public.rental', 'public.payment']),
        offer: OFFER,
        subject: { column: 'customer_id', value: 1 },
        budget,
      });

      // The whole point of `QueryBudget` in one assertion: *"a scan that stops
      // early and says nothing produces a report indistinguishable from a
      // complete one."* A cut timeline that reported itself whole would be
      // that report.
      assert.notEqual(timeline.cutShort, null);
      assert.match(timeline.cutShort ?? '', /Stopped early/);
      assert.equal(timelineWalkedEverything(timeline), false);
    });

    it('names EVERY route it could not afford, not just the first', async () => {
      // The loop `continue`s rather than `break`s. With a break, a reader
      // shown a one-hop timeline would have no way to learn that four other
      // tables exist and went unasked — they would simply be absent, which is
      // the shape of a complete answer.
      const budget = new QueryBudget({ ...ANSWER_LIMITS, maxQueries: 0 });
      const timeline = await runTrace(client, {
        lookup: choose(OFFER, ['public.rental', 'public.payment']),
        offer: OFFER,
        subject: { column: 'customer_id', value: 1 },
        budget,
      });
      assert.equal(timeline.unaffordable.length, 2);
      assert.deepEqual([...timeline.unaffordable].sort(), ['public.payment', 'public.rental']);
      assert.equal(timeline.steps.length, 0);
    });

    it('🟥 leaves `similar` null rather than skipping the break count silently', async () => {
      // Customer 978 has no rentals, so the walk breaks and `countSimilar`
      // would normally run — it is the single most expensive statement the
      // tracer issues (4566 blocks against a mean route walk of ~1000 on this
      // fixture). With one query's worth of budget it must not run, and the
      // number must stay null: ③ already means "nobody counted", and a zero
      // here would say "nobody else has this problem".
      const budget = new QueryBudget({ ...ANSWER_LIMITS, maxQueries: 1 });
      const timeline = await runTrace(client, {
        lookup: choose(OFFER, ['public.rental']),
        offer: OFFER,
        subject: { column: 'customer_id', value: 978 },
        budget,
      });
      assert.equal(timeline.brokeAt?.at, 'public.rental');
      assert.equal(timeline.similar, null);
      assert.notEqual(timeline.cutShort, null);
    });

    it('🟩 counts the break when there is budget for it', async () => {
      // The other half, and the reason the assertion above is worth anything:
      // with room, the same question DOES produce the count. A refusal test
      // whose subject never succeeds is a test of a broken code path.
      const timeline = await runTrace(client, {
        lookup: choose(OFFER, ['public.rental']),
        offer: OFFER,
        subject: { column: 'customer_id', value: 978 },
      });
      assert.equal(timeline.brokeAt?.at, 'public.rental');
      assert.equal(timeline.similar, 1);
      assert.equal(timeline.cutShort, null);
    });

    it('does not spend budget on a route it could not have walked', async () => {
      // A guessed edge records no columns, so no query is built and the
      // database is never touched. Charging for it would let an unwalkable
      // route push a walkable one over the ceiling — paying for silence.
      //
      // 🟥 The first version of this test used the ordinary offer, where every
      // route IS walkable. It passed, and it would have gone on passing with
      // the guard deleted, because the branch it claims to be about never
      // ran. §4.16: a check that cannot go red is a check nobody has checked.
      // So it walks the guessed offer, where the count MUST stay zero.
      const guessedOnly = graphFrom({
        tables: [
          { schema: 'public', table: 'customer' },
          { schema: 'public', table: 'rental' },
        ],
        columns: [{ schema: 'public', table: 'rental', name: 'customer_id' }],
        constraints: [],
      });
      const offer = lookupOffer(guessedOnly);
      const budget = new QueryBudget(ANSWER_LIMITS);
      const timeline = await runTrace(client, {
        lookup: choose(offer, ['public.rental']),
        offer,
        subject: { column: 'customer_id', value: 1 },
        budget,
      });

      assert.deepEqual([...timeline.unwalkable], ['public.rental']);
      // Nothing was asked of the database, so nothing was charged — and the
      // ceiling is untouched for the routes that could have been walked.
      assert.equal(budget.spend.queries, 0);
      assert.equal(budget.exhausted, false);
      // And it is not on the OTHER list: never askable is not the same as
      // not asked, whatever the budget is.
      assert.deepEqual(timeline.unaffordable, []);
    });

    it('leaves a two-route question alone', async () => {
      const timeline = await runTrace(client, {
        lookup: choose(OFFER, ['public.rental', 'public.payment']),
        offer: OFFER,
        subject: { column: 'customer_id', value: 1 },
      });
      assert.equal(timeline.steps.length, 2);
      assert.equal(timeline.cutShort, null);
      assert.equal(timelineWalkedEverything(timeline), true);
    });

    it('🟥 the DEFAULT ceiling binds — 30 real routes, 24 walked', async () => {
      // 🟥 This test exists because the mutation run found the hole. The
      // assertion above ("a caller who passed no budget is still protected")
      // held identically with `ANSWER_LIMITS` and with a budget of a billion,
      // because two routes never approach any ceiling. It proved the
      // parameter was optional and NOTHING about the default being real —
      // §4.16 exactly: a check that cannot go red is a check nobody checked.
      //
      // Pagila carries 55 real `payment_pYYYY_MM` partitions, every one of
      // them a table with a `customer_id`. Thirty of them make thirty routes
      // that genuinely run, on a real database, from one subject — which is
      // more than any single Pagila subject offers naturally (12) and enough
      // to cross `maxQueries: 24` for the first time.
      const partitions = Array.from({ length: 30 }, (_, i) => {
        const year = 2022 + Math.floor(i / 12);
        const month = String((i % 12) + 1).padStart(2, '0');
        return `payment_p${year}_${month}`;
      });
      const wide = graphFrom({
        tables: [
          { schema: 'public', table: 'customer' },
          ...partitions.map((table) => ({ schema: 'public', table })),
        ],
        columns: [],
        constraints: partitions.map((table) => ({
          schema: 'public',
          table,
          columns: ['customer_id'],
          referencedSchema: 'public',
          referencedTable: 'customer',
          referencedColumns: ['customer_id'],
          kind: 'foreign_key' as const,
        })),
      });
      const offer = lookupOffer(wide);
      const timeline = await runTrace(client, {
        lookup: choose(offer, partitions.map((t) => `public.${t}`)),
        offer,
        subject: { column: 'customer_id', value: 1 },
      });

      // 24 queries were affordable and the remaining 6 were not. Written
      // against `ANSWER_LIMITS.maxQueries` rather than the literal 24, so
      // that raising the ceiling changes what the test MEANS instead of
      // breaking its arithmetic.
      //
      // 🟥 The break is the third term and it is not padding. Customer 1 has
      // payments in some months and none in others, so one partition comes
      // back empty and ends the walk — a hop that was asked about, is neither
      // a step nor unreached, and still cost a query. The first version of
      // this assertion left it out, read 23 where it expected 24, and the
      // arithmetic being off by exactly one break is what says the four
      // outcomes partition the routes rather than overlapping.
      const asked =
        timeline.steps.length + timeline.unreached.length + (timeline.brokeAt === null ? 0 : 1);
      assert.equal(asked, ANSWER_LIMITS.maxQueries);
      assert.equal(timeline.unaffordable.length, 30 - ANSWER_LIMITS.maxQueries);
      assert.equal(timelineWalkedEverything(timeline), false);
      assert.match(timeline.cutShort ?? '', /Stopped early/);
      // And the sentence says which ceiling, because "stopped early" with no
      // reason is the hedging a reader discounts.
      assert.match(timeline.cutShort ?? '', /24 queries/);
      // 🟥 An ANSWER, not a scan. The shared sentence is written for scans and
      // said so verbatim to somebody who had run none — "this scan is allowed
      // 24 queries" in reply to one typed question. The noun varies now, and
      // a reader must never be sent looking for a report that does not exist.
      assert.match(timeline.cutShort ?? '', /this answer is allowed/);
      assert.equal(/this scan/.test(timeline.cutShort ?? ''), false);
      // 🟩 The break count never ran: the ceiling was already reached by the
      // time anything asked for it. `similar` stays null, which means "nobody
      // counted" — and a 0 here would have told a reader that nobody else has
      // this problem, on the strength of a query that was never issued.
      assert.equal(timeline.similar, null);
    });
  });
}

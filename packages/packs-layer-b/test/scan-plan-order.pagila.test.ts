/**
 * Does the plan change what gets LOOKED AT, or only what gets listed?
 *
 * Ideal §25 promises the profile reduces wasted scanning. That promise is only
 * kept if the order decides something, and the only place order can decide
 * anything is where the budget runs out — so this is the test that measures it
 * on a real database with a ceiling low enough to bite.
 *
 * ## Why this file exists rather than a unit test of the sort
 *
 * A unit test would prove the comparator sorts. It would not prove the sorted
 * order reaches the loop that spends the budget, and that is the whole claim:
 * *"if I only get to look at half of this, the plan chose which half."* The
 * bug this catches is the one where a priority is accepted, sorted, and then
 * quietly ignored — which compiles, passes every unit test, and leaves the
 * profile decorative.
 *
 * ## The bargain the CLI keeps
 *
 * `npm run scan` passes no priority, so its behaviour is byte-identical. That
 * is asserted here too — a change to a detection pack that altered what the
 * CLI reports would be a change to the report five real readers were shown.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { QueryBudget } from '@ledar/connector-postgres';
import { readSchemaGraph } from '@ledar/connector-postgres';
import { announceSkip, openPagila } from '@ledar/test-fixtures';

import { runImplicitForeignKeys } from '../src/index.js';

const SUITE = 'layer B follows the scan plan (pagila)';

const gate = await openPagila();
if (!gate.ok) announceSkip(SUITE, gate.reason);

after(async () => {
  if (gate.ok) await gate.client.end();
});

if (!gate.ok) {
  describe(`${SUITE} — not run`, () => {
    it('nothing was measured against a real database', { skip: gate.reason }, () => {
      assert.fail('unreachable');
    });
  });
}

/**
 * A ceiling low enough that most candidates are set aside.
 *
 * The number is not tuned to a result — it is the smallest budget that still
 * lets more than one candidate through, so that ORDER can matter at all while
 * most of the list goes unexamined. Which candidates survive is what this file
 * is measuring, and it must not be what the budget was chosen to produce.
 */
const TIGHT = { maxQueries: 3, maxTotalMs: 60_000, maxRowsScanned: 5_000_000 };

describe(SUITE, { skip: !gate.ok }, () => {
  it('🟥 the plan decides which columns the budget is spent on', async () => {
    if (!gate.ok) return;
    const graph = await readSchemaGraph(gate.client, ['public']);

    // Two plans that disagree about one thing: whether a table whose name
    // starts with `damaged_a` is interesting. Nothing about the database
    // changes between the runs — same graph, same seed, same ceiling.
    const first = (_s: string, t: string): number => (t.startsWith('damaged_a') ? 0 : 1);
    const last = (_s: string, t: string): number => (t.startsWith('damaged_a') ? 1 : 0);

    const a = await runImplicitForeignKeys(
      gate.client,
      graph,
      new QueryBudget(TIGHT),
      'en',
      7,
      first,
    );
    const b = await runImplicitForeignKeys(
      gate.client,
      graph,
      new QueryBudget(TIGHT),
      'en',
      7,
      last,
    );

    const examinedA = new Set(
      a.notExamined.map((n) => n.target),
    );
    const examinedB = new Set(
      b.notExamined.map((n) => n.target),
    );

    // Both ran out — otherwise order could not have decided anything and this
    // test would be green over a case it never reached (§4.3).
    assert.ok(a.notExamined.length > 0, 'the ceiling never bit, so order decided nothing');
    assert.ok(b.notExamined.length > 0, 'the ceiling never bit, so order decided nothing');

    // And they set aside DIFFERENT things. This is the whole claim: the plan
    // chose which half of the work the budget paid for.
    assert.notDeepEqual(
      [...examinedA].sort(),
      [...examinedB].sort(),
      'two opposite plans spent the budget on exactly the same columns, so the ' +
        'priority reached the sort and not the loop',
    );

    // The direction is the one asked for, not merely a difference. A shuffle
    // would also produce two different sets.
    const setAsideByA = [...examinedA].filter((t) => t.includes('.damaged_a'));
    const setAsideByB = [...examinedB].filter((t) => t.includes('.damaged_a'));
    assert.ok(
      setAsideByA.length < setAsideByB.length,
      `the plan that asked for damaged_a first set aside ${setAsideByA.length} of them, ` +
        `and the plan that asked for it last set aside ${setAsideByB.length}`,
    );
  });

  it('🟥 passing no plan is exactly the behaviour that shipped before it', async () => {
    if (!gate.ok) return;
    const graph = await readSchemaGraph(gate.client, ['public']);

    // The CLI passes nothing. If `null` ever stopped meaning "the order you
    // already had", `npm run scan` would change under a report five real
    // people were shown, with nothing in this repo saying so.
    const a = await runImplicitForeignKeys(gate.client, graph, new QueryBudget(TIGHT), 'en', 7);
    const b = await runImplicitForeignKeys(
      gate.client,
      graph,
      new QueryBudget(TIGHT),
      'en',
      7,
      null,
    );

    assert.deepEqual(
      a.notExamined.map((n) => n.target),
      b.notExamined.map((n) => n.target),
    );
    assert.equal(a.candidatesVerified, b.candidatesVerified);
  });

  it('a plan orders and never filters — the totals do not move', async () => {
    if (!gate.ok) return;
    const graph = await readSchemaGraph(gate.client, ['public']);

    // Same ceiling, opposite plans. What changes is WHICH candidates were
    // reached; what must not change is how many there were to reach. A plan
    // that could drop one would be a way to narrow a report while the scope
    // strip went on saying the same thing.
    const first = (_s: string, t: string): number => (t.startsWith('damaged_a') ? 0 : 1);
    const last = (_s: string, t: string): number => (t.startsWith('damaged_a') ? 1 : 0);

    const a = await runImplicitForeignKeys(gate.client, graph, new QueryBudget(TIGHT), 'en', 7, first);
    const b = await runImplicitForeignKeys(gate.client, graph, new QueryBudget(TIGHT), 'en', 7, last);

    assert.equal(a.candidatesConsidered, b.candidatesConsidered);
    assert.ok(a.candidatesConsidered > 0, 'no candidates at all, so this compared nothing');
  });
});

/**
 * The two claims Layer A makes when it finds nothing.
 *
 * Run:  npx tsx --test packages/packs-layer-a/test/layer-a-negative-claim.test.ts
 *
 * This branch never runs against the Pagila fixture — the fixture has damage
 * planted in it, so Layer A always has facts to report and the "nothing
 * found" path is never taken. The 5/5 regression therefore proves nothing
 * about any sentence below, which is why these drive `runLayerA` directly
 * with a stub client instead.
 *
 * It used to sit under `packages/contracts/test`, put there by a session
 * that owned that directory and not this one. The note explaining that said
 * it belonged beside the pack and could move without changing a line, and it
 * has: leaving a file where a permissions boundary dropped it is how a later
 * change to `runLayerA` comes to break tests in a package that has nothing to
 * do with it — which is exactly what happened before this was moved.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Client } from 'pg';
import { QueryBudget } from '@ledar/connector-postgres';
import type { Constraint, IndexInfo, SchemaGraph } from '@ledar/connector-postgres';
import { runLayerA as runLayerAOutcome } from '@ledar/packs-layer-a';
import type { SealedFinding } from '@ledar/contracts';

/**
 * `runLayerA` returns its rule-level coverage beside its findings now.
 *
 * Unwrapped once here rather than at each call below. Every case in this file
 * is about the sentences in a claim, and threading the outcome object through
 * all six would put the change in the way of what they are actually asking.
 */
async function runLayerA(
  ...args: Parameters<typeof runLayerAOutcome>
): Promise<Awaited<ReturnType<typeof runLayerAOutcome>>['findings']> {
  return (await runLayerAOutcome(...args)).findings;
}


function fk(table: string): Constraint {
  return {
    name: `${table}_fkey`,
    kind: 'foreign_key',
    schema: 'public',
    table,
    columns: ['parent_id'],
    validated: false,
    definition: 'FOREIGN KEY (parent_id) REFERENCES parent(id) NOT VALID',
    checkExpression: null,
    referencedSchema: 'public',
    referencedTable: 'parent',
    referencedColumns: ['id'],
  };
}

function index(name: string): IndexInfo {
  return {
    name,
    schema: 'public',
    table: 'orders',
    isUnique: true,
    isValid: true,
    isReady: true,
  };
}

function graphOf(constraints: Constraint[], indexes: IndexInfo[]): SchemaGraph {
  return {
    schemas: ['public'],
    tables: [{ schema: 'public', table: 'orders', isPartition: false, partitionOf: null }],
    totalTablesInSchemas: 1,
    constraints,
    indexes,
    columns: [],
    sizes: [],
  };
}

/** Answers or fails per child table, so one run can produce both skip causes. */
function clientThatFailsOn(failing: readonly string[]): Client {
  return {
    async query(sql: string) {
      for (const table of failing) {
        if (sql.includes(`"${table}"`)) {
          throw new Error(`permission denied for table ${table}`);
        }
      }
      return { rows: [{ orphans: 0, violations: 0 }] };
    },
  } as unknown as Client;
}

function budgetOf(maxQueries: number): QueryBudget {
  return new QueryBudget({
    maxQueries,
    maxTotalMs: 1_000_000,
    maxRowsScanned: 1_000_000_000,
  });
}

function pick(findings: readonly SealedFinding[], id: string): SealedFinding {
  const found = findings.find((f) => f.id === id);
  assert.ok(found, `no finding with id ${id}; got ${findings.map((f) => f.id).join(', ')}`);
  return found;
}

/**
 * Narrows to the two branches that carry a boundary, so it is readable.
 *
 * Both, not just `negative`, since debt N8: a rule that reached NONE of its
 * targets publishes `abstained` instead, and the boundary is the whole of what
 * that claim says. Which of the two it is gets asserted where it means
 * something, not here — this helper only needs the sentence.
 */
function boundaryOf(f: SealedFinding): string {
  assert.ok(
    f.kind === 'negative' || f.kind === 'abstained',
    `expected a claim carrying a boundary, got kind "${f.kind}"`,
  );
  return f.kind === 'negative' || f.kind === 'abstained' ? f.boundary : '';
}

// ---------------------------------------------------------------------------
describe('the boundary does not invent a reason for a skip', () => {
  // Three unvalidated foreign keys, one budget query. In order: the first
  // fails its query (and spends nothing), the second succeeds and spends the
  // only query there was, the third is refused for budget. One skip of each
  // cause, in one run.
  async function runMixed(): Promise<readonly SealedFinding[]> {
    const graph = graphOf([fk('t_fails'), fk('t_ok'), fk('t_ceiling')], []);
    return runLayerA(clientThatFailsOn(['t_fails']), graph, budgetOf(1));
  }

  test('a failed query is not reported as running out of budget', async () => {
    const boundary = boundaryOf(pick(await runMixed(), 'layer-a/none/constraints'));

    // The sentence this replaces said "Ran out of budget before 2 of them",
    // which was a claim about cause that nothing measured — and it buried
    // the half that matters more.
    assert.doesNotMatch(boundary, /Ran out of budget before 2/);
  });

  test('both causes are stated, separately, with their own counts', async () => {
    const boundary = boundaryOf(pick(await runMixed(), 'layer-a/none/constraints'));

    assert.match(boundary, /Checked 1 of 3 constraints/);
    assert.match(boundary, /1 was not run at all — the scan reached its ceiling/);
    assert.match(boundary, /1 could not be read: the query failed/);
  });

  test('an unreadable target is named as unseen, not as cleared', async () => {
    const boundary = boundaryOf(pick(await runMixed(), 'layer-a/none/constraints'));
    assert.match(boundary, /not cleared/);
    assert.match(boundary, /unseen/);
    assert.match(boundary, /cannot look inside/);
  });

  test('the machine-readable coverage agrees with the sentence', async () => {
    const constraints = pick(await runMixed(), 'layer-a/none/constraints');
    assert.deepEqual(
      { checked: constraints.coverage.checked, eligible: constraints.coverage.eligible },
      { checked: 1, eligible: 3 },
    );
    assert.equal(constraints.coverage.skipped.length, 2);
  });

  test('when only the ceiling was hit, no failure is implied', async () => {
    const graph = graphOf([fk('a'), fk('b')], []);
    const findings = await runLayerA(clientThatFailsOn([]), graph, budgetOf(0));
    const boundary = boundaryOf(pick(findings, 'layer-a/none/constraints'));

    assert.match(boundary, /2 were not run at all/);
    assert.doesNotMatch(boundary, /could not be read/);
  });

  test('having checked none of them is not reported as an all-clear', async () => {
    const graph = graphOf([fk('a'), fk('b')], []);
    const findings = await runLayerA(clientThatFailsOn([]), graph, budgetOf(0));
    const constraints = pick(findings, 'layer-a/none/constraints');

    assert.match(constraints.plainText, /could not check any of the 2 constraints/);
    assert.match(constraints.plainText, /not the same as nothing being wrong/);
    assert.equal(constraints.coverage.checked, 0);

    // Debt N8, and the half the prose could not carry. The sentence above has
    // always been honest; `kind` said `negative` beside it, and `kind` is what
    // a diff, a model or a spreadsheet actually reads. Two claims that mean
    // opposite things cannot share one machine-readable label.
    assert.equal(
      constraints.kind,
      'abstained',
      `a rule that reached none of its 2 targets published kind ` +
        `"${constraints.kind}". "I looked and found nothing" and "I could not ` +
        `look" are different statements and only the first is a result.`,
    );
  });

  test('reaching some of them is a result, and stays one', async () => {
    // The other side of the line, and the reason this is not just "always
    // abstain when you skipped something". One query is enough budget to
    // check one of the two constraints, so work was done and the claim is a
    // negative — an abstention here would understate the scan in the one
    // direction nobody audits, the direction that looks modest.
    const graph = graphOf([fk('a'), fk('b')], []);
    const findings = await runLayerA(clientThatFailsOn([]), graph, budgetOf(1));
    const constraints = pick(findings, 'layer-a/none/constraints');

    assert.ok(constraints.coverage.checked > 0, 'this case is meant to check one');
    assert.equal(
      constraints.kind,
      'negative',
      `${constraints.coverage.checked} of 2 constraints were checked and the ` +
        `claim called itself "${constraints.kind}". Partial work reported as ` +
        `no work is still a false statement about what happened.`,
    );
  });

  test('nothing to check at all is a result, not an abstention', async () => {
    // A denominator of zero is a fact read out of the catalog: this database
    // has no unvalidated constraints, and the rule looked at everything there
    // was to look at. Calling that an abstention would turn a real answer
    // into a shrug.
    const findings = await runLayerA(clientThatFailsOn([]), graphOf([], []), budgetOf(50));
    const constraints = pick(findings, 'layer-a/none/constraints');

    assert.equal(constraints.coverage.eligible, 0);
    assert.equal(constraints.kind, 'negative');
  });
});

// ---------------------------------------------------------------------------
describe('indexes get their own denominator', () => {
  // The case that made the old sentence false: nothing unvalidated to check,
  // and a pile of perfectly healthy indexes. The single claim used to read
  // "no index was left invalid, across 0 eligible constraints".
  async function runNoConstraintsThreeIndexes(): Promise<readonly SealedFinding[]> {
    const graph = graphOf([], [index('i1'), index('i2'), index('i3')]);
    return runLayerA(clientThatFailsOn([]), graph, budgetOf(50));
  }

  test('there are two claims, one per rule', async () => {
    const findings = await runNoConstraintsThreeIndexes();
    assert.deepEqual(
      findings.map((f) => f.id).sort(),
      ['layer-a/none/constraints', 'layer-a/none/indexes'],
    );
    assert.ok(findings.every((f) => f.kind === 'negative'));
  });

  test('the index claim counts indexes, not constraints', async () => {
    const indexes = pick(await runNoConstraintsThreeIndexes(), 'layer-a/none/indexes');

    assert.equal(indexes.coverage.eligible, 3);
    assert.equal(indexes.coverage.checked, 3);
    assert.match(indexes.plainText, /All 3 indexes/);
    assert.match(boundaryOf(indexes), /Checked all 3 indexes/);
  });

  test('the constraint claim no longer speaks for indexes', async () => {
    const constraints = pick(
      await runNoConstraintsThreeIndexes(),
      'layer-a/none/constraints',
    );
    const said = [
      constraints.plainText,
      constraints.technical,
      boundaryOf(constraints),
    ].join(' ');

    // The exact sentence that used to be published against a denominator of 0.
    assert.doesNotMatch(said, /no index was left invalid/i);
    // Nothing in this claim may assert that indexes are healthy.
    assert.doesNotMatch(said, /index(es)? (are|is) (all )?(valid|fine|enforcing)/i);
    assert.equal(constraints.coverage.eligible, 0);
  });

  test('no index claim is made against the constraint denominator', async () => {
    const findings = await runNoConstraintsThreeIndexes();
    const claimsIndexHealth = findings.filter((f) =>
      /All \d+ index/.test(f.plainText),
    );

    assert.equal(claimsIndexHealth.length, 1);
    assert.equal(claimsIndexHealth[0]?.coverage.eligible, 3);
  });

  test('no visible indexes is a real answer, not a borrowed one', async () => {
    const findings = await runLayerA(
      clientThatFailsOn([]),
      graphOf([], []),
      budgetOf(50),
    );
    const indexes = pick(findings, 'layer-a/none/indexes');

    assert.equal(indexes.coverage.eligible, 0);
    assert.match(indexes.plainText, /cannot see any indexes/);
    // 0 here means "there were none", and the sentence says so. It is not
    // the null that means "I do not know" — the gate keeps those apart.
    assert.notEqual(indexes.coverage.eligible, null);
  });

  test('a healthy index still does not become a claim that it is the right one', async () => {
    const indexes = pick(await runNoConstraintsThreeIndexes(), 'layer-a/none/indexes');
    assert.match(boundaryOf(indexes), /not necessarily the right index/);
  });
});

// ---------------------------------------------------------------------------
describe('both claims are published through the gate', () => {
  test('nothing reaches the caller that the seal did not check', async () => {
    // runLayerA returns SealedFinding[], which only sealFindings can build.
    // Reaching this line at all means both claims passed the shape check,
    // the claim-discipline rules and the coverage rules.
    const findings = await runLayerA(
      clientThatFailsOn(['t_fails']),
      graphOf([fk('t_fails')], [index('i1')]),
      budgetOf(50),
    );

    assert.equal(findings.length, 2);
    for (const f of findings) {
      assert.ok(
        f.kind === 'negative' || f.kind === 'abstained',
        `a claim about finding nothing came back as "${f.kind}"`,
      );
      assert.ok(boundaryOf(f).trim().length > 0);
      assert.notEqual(f.coverage.eligible, null);
      assert.ok(
        f.coverage.checked + f.coverage.skipped.length <= (f.coverage.eligible ?? 0),
      );
    }
  });
});

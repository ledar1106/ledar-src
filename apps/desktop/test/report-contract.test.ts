/**
 * What the window is allowed to know about a finding, and what it is never
 * allowed to infer — milestone A.2, debts N49 and N51.
 *
 * `apps/desktop/src/shared/ipc.ts` was a hand-written copy of shapes that live
 * in `@ledar/contracts`. It rendered correctly, which is why nobody looked at
 * it, and it had already drifted three separate ways before anyone measured
 * (HANDOFF §1c, N49 · N50 · N51 — one cause, three symptoms). The structural
 * half of that fix is not testable from here: it is a build edge, and it is
 * checked by `tsc --build` going red in BOTH halves of this app when a field
 * in contracts is renamed. What IS testable from here is the behaviour the
 * copy had been quietly getting wrong.
 *
 * Three laws, and none of them is about how the screen looks:
 *
 *   1. A negative and an abstention must not reach a reader as the same
 *      sentence. Debt N8 split those claim kinds in the data precisely so a
 *      reader could tell them apart; this surface had been flattening them.
 *   2. Whether a finding is an accusation is carried, not inferred. Reading it
 *      out of `boundary === null` is deriving a category from a correlate.
 *   3. What the budget refused to run reaches the reader — the record and the
 *      screen carry the same sentence, or neither is trustworthy.
 *
 * The budget half is the one with no prior coverage at all: before this file,
 * nothing in the repository called `QueryBudget.disclosure()`. The sentence
 * that exists to keep the promise "never cut quietly" had never once been
 * asserted about.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { QueryBudget } from '@ledar/connector-postgres';
import { ClaimKind } from '@ledar/contracts';
import type { Finding } from '@ledar/contracts';
import { PAGILA_DSN, announceSkip, openPagila } from '@ledar/test-fixtures';
import { ScanStore } from '@ledar/store';

import { closeAllSessions, openSession } from '../src/main/session.js';

const SUITE = 'desktop report contract';

/**
 * The contract's own list of claim kinds, not a copy of it.
 *
 * A copy would be the same mistake this file was written about — five names
 * typed out a second time, agreeing until they do not.
 */
const EVERY_KIND = ClaimKind.options;

/**
 * A finding with nothing interesting in it except the field under test.
 *
 * Built rather than fetched because the two kinds that matter here — an
 * abstention and a negative — do not both come out of the Pagila fixture: it
 * has real faults in it, so its rules RAISE things. Reaching an abstention
 * through a whole scan would mean finding a database that produces one on
 * demand, and a test that cannot reach its own subject is a test that pins
 * nothing while looking like it pins something.
 */
function aFinding(over: { kind: Finding['kind']; boundary?: string }): Finding {
  // Everything a finding needs except the discriminator, taken from a member
  // of the union rather than written as its own shape. A field added to
  // `FindingBase` breaks this helper, which is the correct place to feel it:
  // a test fixture that keeps compiling while the thing it stands in for grows
  // is a fixture that stops standing in for it.
  const base: Omit<Extract<Finding, { kind: 'observation' }>, 'kind'> = {
    id: 'test.finding',
    rule: 'test.rule',
    confidence: 'certain',
    severity: 'info',
    origin: 'catalog',
    confidenceBasis: 'database_constraint',
    egressClass: 'customer-system-metadata',
    observedAt: '2026-08-27T00:00:00.000Z',
    engineRuleVersion: 'test@1.0.0',
    userStatus: 'unreviewed',
    schema: 'public',
    table: 'whatever',
    columns: [],
    plainText: 'a sentence',
    technical: 'a sentence for whoever fixes it',
    boundary: 'somewhere',
    evidence: null,
    coverage: {
      checked: 1,
      eligible: 1,
      skipped: [],
      truncatedAt: null,
      visibleToRole: null,
      verified: 1,
      sampled: 0,
      excluded: 0,
    },
  };

  // One shape for all five kinds since N50 — the branch that used to be here
  // existed only because `boundary` lived on two of them. Not cast: a cast
  // would let this helper go on producing "findings" after the union changes
  // shape, and every assertion below would then be checking something the
  // product cannot actually make.
  return { ...base, kind: over.kind, boundary: over.boundary ?? base.boundary };
}

const HISTORY_DIR = mkdtempSync(join(tmpdir(), 'ledar-report-contract-'));
const HISTORY_DB = join(HISTORY_DIR, 'history.db');
process.env.LEDAR_HISTORY_DB = HISTORY_DB;

// Same reason as `scan-flow.test.ts`: `historyFile()` reads the environment
// when it is called, but a static import is evaluated before any line of this
// file runs, so the module would already have resolved the operator's own
// history path.
const { boundarySentence, runScanFlow } = await import('../src/main/scan-flow.js');

after(() => {
  closeAllSessions();
  rmSync(HISTORY_DIR, { recursive: true, force: true });
});

describe('the sentence a boundary arrives in', () => {
  const LIMIT = 'only the four tables this account can read';

  it('🟥 a negative and an abstention do not read the same', () => {
    const negative = boundarySentence(aFinding({ kind: 'negative', boundary: LIMIT }));
    const abstained = boundarySentence(aFinding({ kind: 'abstained', boundary: LIMIT }));

    assert.notEqual(negative, null, 'a negative reached the window with no boundary at all');
    assert.notEqual(abstained, null, 'an abstention reached the window with no boundary at all');

    // The whole of law 1, in one line. Same limit, same words after the colon,
    // and the reader still has to be able to tell "I looked and found nothing"
    // from "I could not look". If a later tidy-up collapses these onto one
    // lead-in, this is the assertion that stops it.
    assert.notEqual(
      negative,
      abstained,
      'a negative and an abstention rendered identically, so the split debt N8 ' +
        'made in the data does not reach the person reading it',
    );
  });

  it('the limit itself is never cut, whichever lead-in it arrives under', () => {
    // `_doc/25` S6: this belongs to the body of the card and is never cut. A
    // lead-in that REPLACED the sentence rather than introducing it would pass
    // the test above and fail the promise.
    for (const kind of ['negative', 'abstained'] as const) {
      const said = boundarySentence(aFinding({ kind, boundary: LIMIT }));
      assert.ok(
        said !== null && said.includes(LIMIT),
        `the ${kind} lead-in dropped the boundary it was supposed to introduce: ${said}`,
      );
      assert.ok(
        said.length > LIMIT.length,
        `the ${kind} boundary arrived bare — no lead-in at all, which is the ` +
          `state this file exists to keep from coming back`,
      );
    }
  });

  it('🟥 a raised claim states its limits too — there is no kind that does not', () => {
    // This assertion is the inverse of the one it replaces. Until N50 it read
    // `assert.equal(..., null)` for these three kinds, with a message saying
    // that a red here would mean the debt had been paid. It was paid, and the
    // red arrived exactly where the message said it would.
    //
    // Why it matters that a CLAIM has one: a negative with no boundary reads
    // as "there is nothing to find", and a count with no boundary reads as
    // "and this is the whole of it". Same mistake, and the second lands on the
    // findings somebody acts on.
    for (const kind of EVERY_KIND) {
      const said = boundarySentence(aFinding({ kind, boundary: LIMIT }));
      assert.ok(
        said.includes(LIMIT),
        `${kind} reached the window without the limit of its own measurement`,
      );
    }
  });

  it('every claim kind in the contract is answered here, none by default', () => {
    // §4.3 — the loops above would be green over an empty set, and they would
    // also be green if a sixth kind existed that neither loop names. The
    // compiler already refuses that (the switch is exhaustive), so this is the
    // reader-facing half: it fails if the vocabulary grows and this file was
    // not revisited.
    const answered = new Set(['negative', 'abstained', 'observation', 'inference', 'recommendation']);
    assert.deepEqual(
      EVERY_KIND.filter((k) => !answered.has(k)),
      [],
      'a claim kind exists that this file never renders a boundary decision for',
    );
  });
});

describe('what the budget refused to run', () => {
  it('🟥 says so, and names the ceiling it hit', () => {
    // First assertion this repository has ever made about `disclosure()`.
    const budget = new QueryBudget({ maxQueries: 1, maxTotalMs: 60_000, maxRowsScanned: 1_000 });
    assert.equal(budget.disclosure(), null, 'a budget that refused nothing invented a refusal');

    budget.record(5, 10);
    assert.equal(budget.canAfford('one more count'), false, 'the ceiling did not bite');

    const said = budget.disclosure();
    assert.ok(said !== null, 'a check was refused and the budget said nothing about it');
    assert.ok(
      said.includes('1 queries') || said.includes('1 query'),
      `the sentence does not name the ceiling that stopped it: ${said}`,
    );
    assert.match(
      said,
      /not run/,
      `the sentence does not say anything went unrun: ${said}`,
    );
  });
});

const gate = await openPagila();
if (!gate.ok) announceSkip(SUITE, gate.reason);
else await gate.client.end();

if (!gate.ok) {
  describe(`${SUITE} — not run`, () => {
    it('nothing was checked against a real database', { skip: gate.reason }, () => {
      assert.fail('unreachable');
    });
  });
}

describe(SUITE, { skip: !gate.ok }, () => {
  it('🟥 every finding says what kind of claim it is, without anything being inferred', async () => {
    const handle = openSession(PAGILA_DSN);
    const outcome = await runScanFlow(handle);
    assert.equal(outcome.kind, 'scanned', `the scan did not complete: ${JSON.stringify(outcome)}`);
    if (outcome.kind !== 'scanned') return;

    assert.ok(
      outcome.findings.length > 0,
      'the fixture produced no findings, so this checked nothing',
    );

    for (const f of outcome.findings) {
      assert.ok(
        EVERY_KIND.includes(f.kind),
        `a finding crossed the bridge as kind "${f.kind}", which is not in the ` +
          `contract's vocabulary`,
      );
    }

    // The point of N49, stated as the thing that must not be true: if every
    // raised finding had a null boundary and every un-raised one had a
    // sentence, then `boundary === null` would still be a working flag, and
    // the next person would use it. It is no longer the ONLY way to ask,
    // because `kind` is on the wire — and that is what this asserts.
    const kinds = new Set(outcome.findings.map((f) => f.kind));
    assert.ok(kinds.size > 0, 'no kinds were observed');
    console.error(
      `    [note] kinds this run produced: ${[...kinds].sort().join(', ')} ` +
        `(${outcome.findings.length} findings)`,
    );
  });

  it('🟥 the record and the screen say the same thing about what was cut', async () => {
    const handle = openSession(PAGILA_DSN);
    const outcome = await runScanFlow(handle);
    assert.equal(outcome.kind, 'scanned', `the scan did not complete: ${JSON.stringify(outcome)}`);
    if (outcome.kind !== 'scanned') return;

    const store = ScanStore.open(HISTORY_DB);
    try {
      const runs = store.everyRun(200);
      assert.ok(runs.length > 0, 'the scan recorded no run, so there is nothing to compare');
      const latest = runs[0]!;

      // N51 in one line: this value used to reach the history file and stop
      // there, so the file knew something the reader did not. Whatever it is,
      // both sides carry it or the product contradicts itself about its own
      // scan.
      assert.equal(
        outcome.disclosure,
        latest.truncationNote,
        'the run history and the report disagree about what the budget refused',
      );
    } finally {
      store.close();
    }

    // §4.3 and §4.24 together, and this one matters: on Pagila nothing is cut,
    // so the equality above is `null === null` — true, and true for a reason
    // that has nothing to do with the wiring. Said out loud so a green here is
    // never read as proof that the non-null path works. That path is covered
    // by the budget test above, and end to end only on a database large enough
    // to exhaust a 200-query ceiling.
    console.error(
      `    [note] budget disclosure on this run: ${
        outcome.disclosure === null
          ? 'null — nothing was cut, so the comparison above was between two ' +
            'absences and did NOT exercise the non-null path'
          : JSON.stringify(outcome.disclosure)
      }`,
    );
  });
});

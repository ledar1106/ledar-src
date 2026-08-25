/**
 * The tripwire that makes the copied vocabulary safe to have.
 *
 * Debt N29. The store's DDL now spells out every closed vocabulary as a CHECK
 * constraint, which is a second copy of lists that belong to
 * `@ledar/contracts`. The comment that used to sit in that DDL argued against
 * exactly this, on the grounds that a copy goes stale silently — right about
 * the risk, wrong about the conclusion, because this codebase has already
 * learned what to do with a copy that has a good reason to exist.
 *
 * Lesson 14, from three redactors that agreed on every case except the branch
 * nobody could reach: **a copy with a good reason needs a tripwire, not a
 * promise in a comment.** This is the tripwire.
 *
 * It fails in BOTH directions on purpose. A value added to the contract and
 * not to the DDL means the store will refuse a finding the rest of the system
 * considers valid — a scan that runs, finds something, and cannot record it.
 * A value added to the DDL and not to the contract means the fence has a hole
 * shaped like whatever was added. Neither is louder than the other from
 * outside, so neither is allowed to pass.
 *
 * The store still has no runtime dependency on contracts: the import below is
 * test-only, which is the whole point of doing the comparison here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ClaimKind,
  ClaimOrigin,
  Confidence,
  ConfidenceBasis,
  EgressClass,
  LANGS,
  LlmCallOutcome,
  Severity,
  UserStatus,
} from '@ledar/contracts';

import { STORE_VOCABULARY } from '../src/schema.js';

/** Every column the store constrains, beside the enum it is a copy of. */
const PAIRS: readonly { column: string; contract: readonly string[] }[] = [
  { column: 'kind', contract: ClaimKind.options },
  { column: 'confidence', contract: Confidence.options },
  { column: 'severity', contract: Severity.options },
  { column: 'origin', contract: ClaimOrigin.options },
  { column: 'confidenceBasis', contract: ConfidenceBasis.options },
  { column: 'egressClass', contract: EgressClass.options },
  { column: 'userStatus', contract: UserStatus.options },
  // Debt N44. `LANGS` is a plain readonly tuple rather than a zod enum, so it
  // is passed straight through — the pair only needs a list of strings, and
  // wrapping it in an enum purely to satisfy the shape of this table would be
  // a type existing for a test.
  { column: 'lang', contract: LANGS },
  // HS-D D.4. `tier` and `model` on the same table are deliberately NOT
  // here: they are free text, because the tier list belongs to D.1's config
  // and D.1 does not exist. A pair for them would be comparing this store
  // against a decision nobody has made.
  { column: 'llmCallOutcome', contract: LlmCallOutcome.options },
];

describe('the store\'s copy of the contract vocabularies', () => {
  for (const { column, contract } of PAIRS) {
    it(`${column}: the DDL allows exactly what the contract defines`, () => {
      const inStore = STORE_VOCABULARY[column];
      assert.ok(
        inStore,
        `the store constrains no column called ${column}, so this pair is ` +
          `comparing nothing. Either the CHECK was dropped or the key was ` +
          `renamed, and both leave the fence open without failing anywhere else.`,
      );

      const missingFromStore = contract.filter((v) => !inStore.includes(v));
      const extraInStore = inStore.filter((v) => !contract.includes(v as never));

      assert.deepEqual(
        missingFromStore,
        [],
        `@ledar/contracts allows ${missingFromStore.join(', ')} for ${column} ` +
          `and the store's CHECK does not. A scan would run, find something, ` +
          `and then fail to record it — the finding exists and the history ` +
          `does not.`,
      );
      assert.deepEqual(
        extraInStore,
        [],
        `the store's CHECK allows ${extraInStore.join(', ')} for ${column} and ` +
          `the contract does not. The fence has a hole in exactly that shape, ` +
          `and nothing else in the system would notice.`,
      );
    });
  }

  it('every vocabulary the store constrains is compared here', () => {
    // The failure this catches is the quiet one: somebody adds an eighth
    // CHECK to the DDL and does not add a pair above, so the new copy has no
    // tripwire and the suite still passes. A list that guards a list has to
    // guard all of it.
    const compared = PAIRS.map((p) => p.column).sort();
    const constrained = Object.keys(STORE_VOCABULARY).sort();
    assert.deepEqual(
      constrained,
      compared,
      `the store constrains [${constrained.join(', ')}] and this suite ` +
        `compares [${compared.join(', ')}]. Whatever is in the first list and ` +
        `not the second is a copy nobody is watching.`,
    );
  });

  it('no vocabulary is empty, which would constrain nothing', () => {
    for (const [column, values] of Object.entries(STORE_VOCABULARY)) {
      assert.ok(
        values.length > 0,
        `${column} has an empty value list. \`x IN ()\` is not a fence, and ` +
          `the assertions above would compare two empty arrays and agree.`,
      );
    }
  });
});

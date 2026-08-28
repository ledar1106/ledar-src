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
  AreaAnswer,
  ClaimKind,
  ClaimOrigin,
  Confidence,
  ConfidenceBasis,
  EdgeTier,
  EgressClass,
  KnowledgeState,
  LANGS,
  LlmCallOutcome,
  ProfileArea,
  Severity,
  UserStatus,
} from '@ledar/contracts';

import { STORE_VOCABULARY } from '../src/schema.js';

/** Every column the store constrains, beside the enum it is a copy of. */
const PAIRS: readonly {
  column: string;
  contract: readonly string[];
  /**
   * Set when the store is allowed to admit MORE than the contract offers.
   *
   * Only for a vocabulary that has shrunk — see `lang`. It relaxes exactly one
   * of the two assertions below and never the other: the store must still
   * accept everything the product can produce.
   */
  atLeast?: boolean;
}[] = [
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
  //
  // 🟥 `atLeast` since 2026-08-27, and the only pair that is. The product
  // dropped Vietnamese, so `LANGS` shrank while the store's CHECK kept `vi` —
  // on purpose: a run recorded in Vietnamese happened in Vietnamese, and a
  // history that cannot admit the language its own rows carry is not a record.
  //
  // The equality this pair used to assert was right only because no vocabulary
  // had ever shrunk. Note which direction still has to hold: everything the
  // product can render must be storable, or a scan finds something and then
  // cannot write it down. The other direction — the store admitting a value
  // the product no longer produces — is what a record IS.
  { column: 'lang', contract: LANGS, atLeast: true },
  // HS-D D.4. `tier` and `model` on the same table are deliberately NOT
  // here: they are free text, because the tier list belongs to D.1's config
  // and D.1 does not exist. A pair for them would be comparing this store
  // against a decision nobody has made.
  { column: 'llmCallOutcome', contract: LlmCallOutcome.options },
  // Ideal §23, schema 7. Three lists arrived with one table, and they are the
  // exact shape N50 was filed about: `schema.ts` already had a tripwire, so
  // the question *"is this vocabulary watched?"* looked answered while a third
  // copy sat two hundred lines away in `store.ts`. Counted this time rather
  // than eyeballed — the DDL constrains these three, `profile.ts` reads
  // `STORE_VOCABULARY` instead of typing a fourth copy, and these pairs close
  // the loop back to the contract.
  //
  // 🟥 `knowledgeState` is the one that would hurt most. The four union CHECKs
  // on `project_profile_area` are each phrased `state <> 'x' OR (...)`, so a
  // rung the DDL admitted and the constraints did not name would satisfy all
  // four vacuously — a `verified` by another name, with no evidence and no
  // confirmation, and nothing anywhere would fail.
  { column: 'profileArea', contract: ProfileArea.options },
  { column: 'knowledgeState', contract: KnowledgeState.options },
  { column: 'areaAnswer', contract: AreaAnswer.options },
  // 🟥 `edgeTier` matters for the same reason `knowledgeState` does.
  // `rate_belongs_to_measured` is phrased against the literal 'measured', so a
  // fourth tier the DDL admitted and that constraint did not name would carry
  // a match rate with nothing checking it — a counted-looking number on an
  // edge nobody counted, which is the one thing the tier system exists to
  // stop.
  { column: 'edgeTier', contract: EdgeTier.options },
];

describe('the store\'s copy of the contract vocabularies', () => {
  for (const { column, contract, atLeast } of PAIRS) {
    const what = atLeast === true ? 'allows at least' : 'allows exactly';
    it(`${column}: the DDL ${what} what the contract defines`, () => {
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
      if (atLeast === true) {
        // Said out loud rather than skipped silently (§4.3): a relaxed
        // assertion that leaves no trace reads exactly like one that passed.
        console.error(
          `    [note] ${column}: store admits ${extraInStore.length} value(s) the ` +
            `product no longer renders${
              extraInStore.length === 0 ? '' : ` (${extraInStore.join(', ')})`
            } — allowed for this column, see the pair's comment`,
        );
        return;
      }
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

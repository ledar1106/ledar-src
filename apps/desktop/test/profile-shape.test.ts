/**
 * The map screen: what each rung is allowed to look like, and what it may
 * never offer. No DOM in this file.
 *
 * Ideal §12's audit is the reason this screen exists at all:
 *
 * > *"Scan trước (rẻ, tự động) → Trình bày cái tìm được → User chỉ bấm
 * > Đúng/Sai. Câu hỏi cũ đòi KIẾN THỨC; câu hỏi mới chỉ đòi XÁC NHẬN điều đã
 * > thấy."*
 *
 * A person is asked to RECOGNISE, not to know. That bargain only holds if the
 * card in front of them is honest about how the product came to put it there,
 * so the load-bearing claims here are not about layout:
 *
 * ```text
 * 1. the five rungs are the contract's five, in the contract's order
 * 2. no two rungs are told apart by a class name alone
 * 3. only a rung that was SHOWN something may offer the control that mints
 *    `verified` — the one rung in the product that means a human signed it
 * 4. exactly one rung asks instead of telling, and it is `suspected`
 * 5. the two directions of a disagreement do not look alike, and the one
 *    about the LIMIT OF OUR SIGHT never wears the shape of a finding about
 *    somebody's system
 * 6. every word in every one of those vocabularies has copy to render
 * ```
 *
 * ⚠️ What this suite cannot see: the stylesheet. `tone` is a class name, and
 * whether `.rung.stated` and `.rung.observed` actually differ on a screen is
 * decided in `styles.css` and measured by looking. What is checkable from
 * here is that the record does not LEAN on that class name — claim 2 — which
 * is the half that would rot silently.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AreaAnswer, AreaKnowledge, KnowledgeState, PROFILE_AREAS } from '@ledar/contracts';

import { en } from '../src/renderer/i18n/en.js';
import {
  EVERY_RUNG,
  RUNGS_WITH_EVIDENCE,
  shapeForDirection,
  shapeForRung,
} from '../src/renderer/profile-shape.js';
import type { ConflictDirection, RungShape } from '../src/renderer/profile-shape.js';

/**
 * Both directions, declared rather than sniffed.
 *
 * `ProfileConflict['direction']` is a plain union with no runtime list behind
 * it, so a third direction added to the contract has to fail `tsc -p
 * tsconfig.test.json` here with a missing property rather than leave this
 * file quietly testing two of three. AGENTS §4.3 — a safe gate is a declared
 * whitelist, never a blacklist.
 */
const EVERY_DIRECTION: Record<ConflictDirection, true> = {
  said_no_found_yes: true,
  said_yes_found_no: true,
};

const DIRECTIONS = Object.keys(EVERY_DIRECTION) as ConflictDirection[];

/**
 * What "reads as a finding about your system" means, said once.
 *
 * Named rather than pattern-matched, for the reason `verdict-shape.test.ts`
 * names its reassuring tone: a test that asked "does this look accusing"
 * would be a blacklist, and §4.3 has a paragraph on where those turn out to
 * be empty.
 */
const FINDING_TONE = 'found';
const FINDING_ICON = 'alert';

describe('the ladder the window draws is the ladder the contract defines', () => {
  it('🟥 is the contract’s rungs, in the contract’s order', () => {
    // Claim 1. `EVERY_RUNG` is derived from a record the compiler checks
    // against `KnowledgeState`, so this cannot go red for a MISSING rung —
    // that is a build error one layer down. What it catches is the other
    // half: a rung reordered or renamed on one side only. The smoke line
    // prints these names, and a line whose vocabulary has drifted from the
    // contract is a line nobody can compare across two runs.
    assert.deepEqual([...EVERY_RUNG], [...KnowledgeState.options]);
  });

  it('🟥 agrees with the contract about which rungs carry evidence', () => {
    // Read out of `AreaKnowledge` itself rather than written down again. The
    // claim "evidence is empty on exactly `unknown` and `stated`" lives as a
    // comment in `shared/ipc.ts`; this is that comment turned into something
    // that can fail. Everything downstream — which cards show a "where I saw
    // it" block, which cards may offer the confirm control — hangs off it.
    const fromContract = AreaKnowledge.options
      .filter((option) => 'evidence' in option.shape)
      .map((option) => option.shape.state.value);

    assert.deepEqual([...RUNGS_WITH_EVIDENCE].sort(), fromContract.sort());
  });

  it('answers every rung, which is what lets the rest of this file fail', () => {
    for (const rung of EVERY_RUNG) {
      const shape = shapeForRung(rung);
      assert.equal(shape.tone, rung, `${rung} is drawn under some other rung’s name`);
      assert.equal(typeof shape.confirmable, 'boolean');
      assert.equal(typeof shape.asksInstead, 'boolean');
      assert.equal(typeof shape.settled, 'boolean');
    }
    assert.equal(EVERY_RUNG.length, 5);
  });
});

describe('no two rungs may be read as the same thing', () => {
  it('🟥 none of them is told apart by its class name alone', () => {
    // Claim 2. `tone` is a CSS hook and a CSS hook is, in the end, a colour —
    // `_doc/25` 3.3 ① says meaning may never live there alone, and a
    // colour-blind reader is a design constraint rather than an option. So
    // the comparison sets `tone` aside and asks whether what is left still
    // separates all five.
    //
    // This has a real way to go red: give `unknown` a null icon and it
    // becomes indistinguishable from `stated` here, which is exactly the day
    // "nobody said anything" and "they told me" start looking alike on
    // screen.
    const seen = new Map<string, string>();
    for (const rung of EVERY_RUNG) {
      const { tone: _tone, ...rest } = shapeForRung(rung);
      const key = JSON.stringify(rest);
      const clash = seen.get(key);
      assert.equal(
        clash,
        undefined,
        `"${rung}" and "${clash}" differ only by their class name: ${key}`,
      );
      seen.set(key, rung);
    }
  });

  it('is a pure function of the rung — the same rung twice is the same shape', () => {
    for (const rung of EVERY_RUNG) {
      assert.deepEqual(shapeForRung(rung), shapeForRung(rung));
    }
  });
});

describe('the control that mints `verified`', () => {
  it('🟥 is never offered on a card with nothing on it to agree with', () => {
    // Claim 3, and it is a safety rule rather than a layout one. `verified`
    // means a human looked at a measurement and signed it. A confirm button
    // on `unknown` or `stated` would make the rung sometimes mean "a person
    // clicked next to a blank space", and no later screen could tell the two
    // apart. main/profile-flow.ts refuses those calls; this is the same rule
    // on the surface somebody actually presses.
    for (const rung of EVERY_RUNG) {
      if (!shapeForRung(rung).confirmable) continue;
      assert.ok(
        RUNGS_WITH_EVIDENCE.includes(rung),
        `"${rung}" offers the confirm control and has no evidence to show`,
      );
    }
  });

  it('🟥 is not offered again on the rung that has already been agreed', () => {
    assert.equal(shapeForRung('verified').confirmable, false);
  });

  it('is offered on both rungs that were shown something, so the rules above are watching', () => {
    // Without this the two rules could pass by nobody offering the control at
    // all — the empty-set green §4.3 warns about. Two rungs carry evidence a
    // person has not yet signed, and both must ask.
    assert.equal(shapeForRung('observed').confirmable, true);
    assert.equal(shapeForRung('suspected').confirmable, true);
  });
});

describe('what may be told, and what must be asked', () => {
  it('🟥 exactly one rung asks instead of telling, and it is `suspected`', () => {
    // Claim 4. Hard rule ③ forbids stating an unconfirmed thing as fact, and
    // `_doc/25` 3.3 ② says the visual has to obey the same rule the copy
    // does. `suspected` is the rung that exists because something was seen
    // that might mean this — announcing it would be the product inventing a
    // system for somebody on the strength of a table name.
    const asking = EVERY_RUNG.filter((rung) => shapeForRung(rung).asksInstead);
    assert.deepEqual(asking, ['suspected']);
  });

  it('🟥 exactly one rung may look settled, and it is `verified`', () => {
    const settled = EVERY_RUNG.filter((rung) => shapeForRung(rung).settled);
    assert.deepEqual(settled, ['verified']);
  });

  it('the rung that is settled is the one a person signed, not the one we measured', () => {
    // `observed` is a measurement and `verified` is a measurement somebody
    // agreed with. Collapsing them would let the product treat its own
    // reading as a decision — the exact thing `reconcile` refuses to do when
    // it says `verified` is NEVER produced there.
    assert.equal(shapeForRung('observed').settled, false);
  });
});

describe('the two directions of a disagreement', () => {
  it('🟥 the one about the limit of OUR sight does not wear the shape of a finding', () => {
    // Claim 5, and the sharpest rule on this screen. `conflictsIn` in the
    // contract states what the failure would be: *"Treating it as their error
    // would be the product mistaking the edge of its own vision for the edge
    // of the world."* Somebody who says "yes, we store files" is almost
    // certainly right and it simply is not in this database.
    const unseen = shapeForDirection('said_yes_found_no');
    assert.notEqual(unseen.tone, FINDING_TONE);
    assert.notEqual(unseen.icon, FINDING_ICON);
  });

  it('the other direction is the one that may, so the rule above is watching something', () => {
    const found = shapeForDirection('said_no_found_yes');
    assert.equal(found.tone, FINDING_TONE);
    assert.equal(found.icon, FINDING_ICON);
  });

  it('🟥 the two do not look alike, compared whole', () => {
    assert.notDeepEqual(
      shapeForDirection('said_no_found_yes'),
      shapeForDirection('said_yes_found_no'),
    );
  });

  it('answers every direction', () => {
    for (const direction of DIRECTIONS) {
      const shape = shapeForDirection(direction);
      assert.ok(shape.tone.length > 0);
      assert.ok(shape.icon.length > 0);
    }
    assert.equal(DIRECTIONS.length, 2);
  });
});

describe('every word the map renders has copy behind it', () => {
  it('🟥 every rung has a label and a sentence', () => {
    // Claim 6, and the same failure mode `interview.test.ts` rule 5 guards:
    // these names cross the bridge as strings, so nothing else checks them
    // against the catalogue. Without this a rung added to the contract
    // reaches a person as a blank card — and a blank card in a map is read as
    // "there is nothing there", which is a different and false statement.
    const missing: string[] = [];
    for (const rung of KnowledgeState.options) {
      if (!(`profile.state.${rung}` in en)) missing.push(`profile.state.${rung}`);
      if (!(`profile.state.${rung}.body` in en)) missing.push(`profile.state.${rung}.body`);
    }
    assert.deepEqual(missing, [], `missing catalogue keys: ${missing.join(', ')}`);
  });

  it('🟥 every area has a name of its own, separate from the question that asked about it', () => {
    // Two keys per area on purpose. `interview.area.*` asks a question;
    // `profile.area.*` names a thing. Re-using the question as the heading
    // would put "Does your system log people in?" above a card that has
    // already answered it.
    const missing: string[] = [];
    for (const area of PROFILE_AREAS) {
      if (!(`profile.area.${area}` in en)) missing.push(`profile.area.${area}`);
    }
    assert.deepEqual(missing, [], `missing catalogue keys: ${missing.join(', ')}`);

    for (const area of PROFILE_AREAS) {
      assert.notEqual(
        en[`profile.area.${area}` as keyof typeof en],
        en[`interview.area.${area}` as keyof typeof en],
        `"${area}" uses its interview question as its map heading`,
      );
    }
  });

  it('🟥 every answer a person can give can be said back to them', () => {
    const missing: string[] = [];
    for (const said of AreaAnswer.options) {
      if (!(`profile.said.${said}` in en)) missing.push(`profile.said.${said}`);
    }
    assert.deepEqual(missing, [], `missing catalogue keys: ${missing.join(', ')}`);
  });

  it('🟥 the two directions are not phrased alike', () => {
    // The rule the brief states outright. Shapes differing is half of it;
    // this is the other half, and it is the half a rewrite breaks first,
    // because one sentence covering both directions always reads tighter.
    const headlines = DIRECTIONS.map((d) => en[`profile.conflict.${d}.headline` as keyof typeof en]);
    const bodies = DIRECTIONS.map((d) => en[`profile.conflict.${d}.body` as keyof typeof en]);

    for (const line of [...headlines, ...bodies]) assert.ok(line.trim().length > 0);
    assert.notEqual(headlines[0], headlines[1]);
    assert.notEqual(bodies[0], bodies[1]);
  });

  it('🟥 the direction about our own limit says whose limit it is', () => {
    // ⚠️ A phrase pin is a coarse instrument: it catches a deletion or a
    // revert, not a rephrase that keeps the words and loses the meaning. It
    // is here because the deletion is the likely failure — the half of this
    // card that admits a gap is the half a tightening edit removes first, and
    // what is left then reads as the product doubting the person.
    const body = en['profile.conflict.said_yes_found_no.body'];
    assert.match(body, /how far I can see/);
    assert.match(body, /my gap/);
  });

  it('🟥 the direction about their system says outright that nothing is broken', () => {
    // The sentence that stops the loudest card on the map being read as an
    // accusation. It is not a finding: it is a part of their system that was
    // not on their list.
    assert.match(en['profile.conflict.said_no_found_yes.body'], /broken/);
  });
});

describe('the shape record is what the renderer reads', () => {
  it('offers no rung a shape it did not declare', () => {
    // Cheap, and it is what stops this whole file from being a test of an
    // object literal that nothing calls: `shapeForRung` is the function the
    // renderer uses, and every assertion above goes through it.
    const shapes: RungShape[] = EVERY_RUNG.map(shapeForRung);
    assert.equal(shapes.length, EVERY_RUNG.length);
    assert.ok(shapes.every((s) => s.icon === null || typeof s.icon === 'string'));
  });
});

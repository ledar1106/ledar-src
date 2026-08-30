/**
 * The four shapes a G3 answer may take, and the two notes none may swallow.
 *
 * `verdict-shape.test.ts` guards the same rule one screen earlier: one reader
 * in five read a near-empty report as *"most of the database is fine"*. A
 * timeline that found nothing has exactly that shape, and this file is where
 * that is kept from happening again.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { timelineFrom } from '@ledar/contracts';
import type { EntityEdge, HopResult, Timeline } from '@ledar/contracts';

import { answerIsWhole, askGaps, askKind, askShape, mustShow } from '../src/renderer/ask-shape.js';

function edge(): EntityEdge {
  return {
    from: { schema: 'public', table: 'customer' },
    to: { schema: 'public', table: 'rental' },
    via: 'customer_id',
    why: 'a declared foreign key',
    tier: 'declared',
    matched: null,
    join: { from: ['customer_id'], to: ['customer_id'] },
  };
}

function hop(over: Partial<HopResult> = {}): HopResult {
  const rows = 'rows' in over ? (over.rows ?? null) : 3;
  return {
    entity: 'public.rental',
    via: 'customer_id',
    path: [edge()],
    rows,
    at: '2026-08-28T10:00:00.000Z',
    timeColumn: 'rental_date',
    unasked: rows === null ? 'no-columns-to-join-on' : null,
    ...over,
  };
}

const walked = (): Timeline => timelineFrom('public.customer', [hop()], []);
const broke = (): Timeline =>
  timelineFrom('public.customer', [hop({ rows: 2 }), hop({ entity: 'public.payment', rows: 0 })], []);
/** No steps, no break — the subject was not there. */
const nothing = (): Timeline => timelineFrom('public.customer', [], []);
/** The lookup declined to aim. `runTrace` passes an empty subject for this. */
const outside = (): Timeline => timelineFrom('', [], ['external_service']);

/** The four, each with the fact the main side would have carried across. */
const SHAPES_UNDER_TEST: readonly (readonly [Timeline, boolean])[] = [
  [walked(), false],
  [broke(), false],
  [nothing(), false],
  [outside(), true],
];

describe('the four answers, and no two alike', () => {
  it('names each one', () => {
    assert.equal(askKind(walked(), false), 'walked');
    assert.equal(askKind(broke(), false), 'broke');
    assert.equal(askKind(nothing(), false), 'nothing');
    // 🟥 The fact comes from the main side, because the renderer cannot import
    // a runtime value from `@ledar/contracts` — it is served to a browser with
    // no bundler. The first version read the sentinel itself, compiled, passed
    // 1135 tests, and left the window blank.
    assert.equal(askKind(outside(), true), 'outside');
  });

  it('🟥 no two of the four share a whole appearance', () => {
    // Per-kind rather than per-field, which is the claim `_doc/25` S5 makes.
    // Two fields may coincide; the triple may not.
    const seen = new Set<string>();
    for (const [t, nowhere] of SHAPES_UNDER_TEST) {
      const s = askShape(t, nowhere);
      const key = `${s.tone}|${s.icon}|${String(s.bannerAtTop)}`;
      assert.equal(seen.has(key), false, `two answers look identical: ${key}`);
      seen.add(key);
    }
  });

  it('🟥 an empty timeline carries NO success styling and the only banner', () => {
    // RỖNG ≠ SẠCH. Zero hops is what a healthy subject and a missing subject
    // both produce, and this card is the only thing standing between them.
    const s = askShape(nothing(), false);
    assert.notEqual(s.tone, 'ok');
    assert.notEqual(s.icon, 'check');
    assert.equal(s.bannerAtTop, true);
    // Every OTHER kind carries no banner, so the loudest signal is spent once.
    for (const [other, nowhere] of SHAPES_UNDER_TEST) {
      if (askKind(other, nowhere) === 'nothing') continue;
      assert.equal(
        askShape(other, nowhere).bannerAtTop,
        false,
        'a second banner would spend the loudest signal',
      );
    }
  });

  it('🟥 a question a database cannot answer is not dressed as a failure', () => {
    // The Admit half of ideal §1, which ㉜d measured breaking on its own. A
    // reader taught that an honest admission looks like an error stops
    // believing the admissions.
    const s = askShape(outside(), true);
    assert.notEqual(s.tone, 'alarm');
    assert.notEqual(s.icon, 'alert');
    assert.equal(s.bannerAtTop, false);
  });

  it('nothing in the set wears the tick', () => {
    // `check` is spent on the one honest all-clear in `verdict-shape`, and a
    // timeline has none to give: a complete walk describes what happened, it
    // does not find that all is well.
    for (const [t, nowhere] of SHAPES_UNDER_TEST) {
      assert.notEqual(askShape(t, nowhere).icon, 'check');
    }
  });
});

describe('three absences, kept apart', () => {
  const withGaps = (): Timeline =>
    timelineFrom(
      'public.customer',
      [
        hop({ entity: 'public.rental', rows: 2 }),
        hop({ entity: 'public.invoice', rows: null, unasked: 'no-columns-to-join-on' }),
        hop({ entity: 'public.payment', rows: 0 }),
        hop({ entity: 'public.refund', rows: 4 }),
        hop({ entity: 'public.shipment', rows: null, unasked: 'budget-spent' }),
      ],
      [],
      null,
      'Stopped early: …',
    );

  it('🟥 gives each its own heading and never merges them', () => {
    const gaps = askGaps(withGaps());
    assert.deepEqual(
      gaps.map((g) => g.kind).sort(),
      ['unaffordable', 'unreached', 'unwalkable'],
    );
    // Three distinct catalogue keys. One shared key would be three headings
    // reading the same, which is merging with extra steps.
    assert.equal(new Set(gaps.map((g) => g.labelKey)).size, 3);
    for (const g of gaps) assert.ok(g.entities.length > 0);
  });

  it('drops the empty ones instead of drawing them', () => {
    // A heading with nothing under it reads as a category the product checked
    // and found clear, which is the same lie as calling an empty table clean.
    assert.deepEqual(askGaps(walked()), []);
  });
});

describe('the two notes no shape may swallow', () => {
  it('🟥 puts provenance BEFORE the answer and the cut AFTER it', () => {
    const t = timelineFrom('public.customer', [hop()], [], null, 'Stopped early: …');
    const notes = mustShow(t, 'The question itself named public.staff…');
    assert.equal(notes.length, 2);
    // Ordered, not a set. A reader who learns where the answer was aimed only
    // after reading the rows has already believed the rows.
    assert.equal(notes[0]!.where, 'before');
    assert.match(notes[0]!.text, /named public\.staff/);
    assert.equal(notes[1]!.where, 'after');
  });

  it('says nothing when there is nothing to say', () => {
    assert.deepEqual(mustShow(walked(), null), []);
  });

  it('🟥 a cut answer never reports itself whole', () => {
    assert.equal(answerIsWhole(walked()), true);
    assert.equal(
      answerIsWhole(timelineFrom('public.customer', [hop()], [], null, 'Stopped early: …')),
      false,
    );
    assert.equal(
      answerIsWhole(
        timelineFrom(
          'public.customer',
          [hop(), hop({ entity: 'public.x', rows: null, unasked: 'budget-spent' })],
          [],
        ),
      ),
      false,
    );
  });
});

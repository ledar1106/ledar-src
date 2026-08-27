/**
 * The four verdicts, and the one a real reader got wrong.
 *
 * `_doc/25` 3.3 ③ is not a style preference, it is a measurement: **RỖNG ≠
 * SẠCH**, and one reader in five read a near-empty report as *"ổn rồi"*. An
 * empty database scanned to zero findings is the place this product is most
 * able to lie without saying anything false, and the brief's answer is that
 * the visuals must block it rather than help — no tick, no ok colour, not a
 * pixel of it. The demo shipped it wrong once already.
 *
 * So the load-bearing test here is not that `shapeFor` returns a shape. It is
 * that `nothing_seen` cannot come back wearing the one costume that means
 * *everything is fine*.
 *
 * The second claim is `_doc/25` §4: **BỐN hình dạng, không hai cái nào được
 * trông giống nhau**. Compared as whole shapes, because two kinds that share
 * an icon and a banner position and differ only in tone are two kinds a
 * colour-blind reader cannot tell apart — 3.3 ① makes that a design
 * constraint, not an option.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ReportVerdict } from '../src/shared/ipc.js';
import { shapeFor } from '../src/renderer/verdict-shape.js';
import type { VerdictShape } from '../src/renderer/verdict-shape.js';

/**
 * Every kind, declared rather than sniffed.
 *
 * A `Record` over the union rather than an array: add a fifth verdict kind to
 * `ipc.ts` and `tsc -p tsconfig.test.json` fails here with a missing
 * property, instead of this file quietly continuing to test four of five.
 * AGENTS.md §4.3 — the safe gate is a declared whitelist, never a blacklist.
 */
const EVERY_KIND: Record<ReportVerdict['kind'], true> = {
  nothing_seen: true,
  silence_with_gaps: true,
  silence_is_clean: true,
  raised: true,
};

const KINDS = Object.keys(EVERY_KIND) as ReportVerdict['kind'][];

/** Same discipline for the two vocabularies the shape is drawn from. */
const EVERY_TONE: Record<VerdictShape['tone'], true> = {
  attention: true,
  ok: true,
  pending: true,
  alarm: true,
};

const EVERY_ICON: Record<VerdictShape['icon'], true> = {
  check: true,
  dash: true,
  shield: true,
  arrow: true,
  alert: true,
};

/**
 * What "looks reassuring" means, said once and in one place.
 *
 * Named rather than pattern-matched. A test that asked "does this tone look
 * happy" would be a blacklist, and §4.3 has a whole paragraph on where those
 * turn out to be empty.
 */
const REASSURING_TONE: VerdictShape['tone'] = 'ok';
const REASSURING_ICON: VerdictShape['icon'] = 'check';

/** The whole shape as one comparable string, in a fixed field order. */
function asText(shape: VerdictShape): string {
  return `tone=${shape.tone} icon=${shape.icon} bannerAtTop=${shape.bannerAtTop}`;
}

describe('shapeFor answers all four kinds, which is what lets the rest of this file fail', () => {
  it('returns a well-formed shape for every kind', () => {
    // 🟥 This is not a formality. `shapeFor` returning `undefined` for a kind
    // it forgot would make `shape.tone !== 'ok'` pass — undefined is not
    // 'ok' — and the most important test in this slice would go green on the
    // most broken implementation possible. AGENTS.md §4.3: pin that there is
    // something to examine before examining it.
    assert.equal(KINDS.length, 4);

    for (const kind of KINDS) {
      // Typed wider than the signature deliberately. The signature is a
      // promise; this test is here because promises are what break.
      const shape: VerdictShape | undefined = shapeFor(kind);
      if (shape === undefined || shape === null) {
        assert.fail(`shapeFor('${kind}') returned nothing`);
      }

      assert.ok(
        Object.hasOwn(EVERY_TONE, shape.tone),
        `shapeFor('${kind}').tone is '${shape.tone}', which is not a declared tone`,
      );
      assert.ok(
        Object.hasOwn(EVERY_ICON, shape.icon),
        `shapeFor('${kind}').icon is '${shape.icon}', which is not a declared icon`,
      );
      assert.equal(
        typeof shape.bannerAtTop,
        'boolean',
        `shapeFor('${kind}').bannerAtTop is not a boolean`,
      );
    }
  });

  it('is a pure function of the kind — the same kind twice is the same shape', () => {
    for (const kind of KINDS) {
      assert.equal(asText(shapeFor(kind)), asText(shapeFor(kind)));
    }
  });
});

describe('empty is not clean', () => {
  it('nothing_seen carries no success styling: not the ok tone, not the check icon', () => {
    // 🟥 THE test. `_doc/25` 3.3 ③, measured with real readers: 1 in 5 read a
    // near-empty report as "ổn rồi". A tick on an empty database is the
    // product agreeing with them.
    const empty = shapeFor('nothing_seen');

    assert.notEqual(
      empty.tone,
      REASSURING_TONE,
      "an empty database is styled 'ok' — _doc/25 3.3 ③ says not one pixel of it",
    );
    assert.notEqual(
      empty.icon,
      REASSURING_ICON,
      "an empty database is given the tick icon — a clean result on an empty database means nothing was looked at",
    );
  });

  it('nothing_seen puts its warning at the TOP of the report', () => {
    // `_doc/25` §4, verdict D: "cảnh báo ở ĐẦU báo cáo + kết luận cuối". The
    // conclusion at the bottom is where the reader who scrolled arrives; the
    // banner at the top is for the reader who does not.
    assert.equal(
      shapeFor('nothing_seen').bannerAtTop,
      true,
      'the empty-database warning is not raised to the top of the report',
    );
  });
});

describe('no two verdicts may look alike', () => {
  it('all four shapes differ, compared whole and not one field at a time', () => {
    // `_doc/25` §4: "BỐN hình dạng, không hai cái nào được trông giống nhau".
    const seen = new Map<string, ReportVerdict['kind']>();

    for (const kind of KINDS) {
      const text = asText(shapeFor(kind));
      const twin = seen.get(text);
      assert.equal(
        twin,
        undefined,
        `'${kind}' and '${twin}' render identically: ${text}`,
      );
      seen.set(text, kind);
    }

    assert.equal(seen.size, 4);
  });

  it('no two differ by colour alone — a reader who cannot see colour must still see four', () => {
    // `_doc/25` 3.3 ①: meaning is never carried by colour alone; every state
    // is text + shape + colour, and colour blindness is a constraint rather
    // than a preference. `tone` is the colour channel. `icon` and
    // `bannerAtTop` are the two channels that survive it, so every pair has
    // to differ in at least one of them.
    //
    // This is deliberately stronger than whole-shape distinctness above,
    // which four different tones alone would satisfy.
    for (let i = 0; i < KINDS.length; i += 1) {
      for (let j = i + 1; j < KINDS.length; j += 1) {
        const left = KINDS[i]!;
        const right = KINDS[j]!;
        const a = shapeFor(left);
        const b = shapeFor(right);

        assert.ok(
          a.icon !== b.icon || a.bannerAtTop !== b.bannerAtTop,
          `'${left}' and '${right}' differ only in colour (both icon '${a.icon}', ` +
            `bannerAtTop ${a.bannerAtTop}) — _doc/25 3.3 ① forbids meaning that lives in the palette`,
        );
      }
    }
  });
});

describe('only the covered silence may reassure', () => {
  it('no other kind wears the ok tone or the tick', () => {
    // `_doc/25` §4: B ("im lặng, phủ đủ") is the only one allowed to be
    // gentle. C is silence with holes in it and D is an empty database; both
    // of those saying "ok" is the product claiming coverage it did not have.
    for (const kind of KINDS) {
      if (kind === 'silence_is_clean') continue;
      const shape = shapeFor(kind);

      assert.notEqual(
        shape.tone,
        REASSURING_TONE,
        `'${kind}' is styled as an all-clear`,
      );
      assert.notEqual(
        shape.icon,
        REASSURING_ICON,
        `'${kind}' wears the tick, which only a covered silence has earned`,
      );
    }
  });

  it('silence_is_clean is the kind that may, so the rule above is watching something', () => {
    // Without this, "nothing else is 'ok'" is also satisfied by a shapeFor
    // that never returns 'ok' at all — an assertion that cannot go red, and
    // §4.16 counts three of those as worse than having none. 'ok' is in the
    // tone union for exactly one consumer; this is that consumer.
    assert.equal(
      shapeFor('silence_is_clean').tone,
      REASSURING_TONE,
      "the product has no all-clear shape at all, so the 'ok' tone is dead and nothing above is being watched",
    );
  });
});

/**
 * How each of the four verdicts is allowed to look. No DOM in this file.
 *
 * `_doc/25` S5 states the requirement as a measurement rather than a taste:
 * *"Phán quyết có BỐN hình dạng, không hai cái nào được trông giống nhau"* —
 * four shapes, no two alike — and records why it is written that way. One
 * reader in five read a near-empty report as *"most of the database is fine"*
 * in the VS-7 round. The mapping lives here, apart from the renderer, because
 * a rule that decides what a person believes about their own database is
 * worth being able to test without a window in the room — the same reason
 * `interview.ts` and `packages/contracts/src/verdict.ts` are pure.
 *
 * ## 🟥 `nothing_seen` carries no success styling. Not one pixel.
 *
 * `_doc/25` 3.3 ③: *RỖNG ≠ SẠCH* — empty is not clean. A database with no
 * rows produces zero findings, and zero findings is the same absence a clean
 * database produces. The report is the only thing standing between those two
 * meanings, so the empty one gets: no tick, no `ok` tone, and the only
 * `bannerAtTop` in the set, because `_doc/25` S5 D asks for the warning at the
 * TOP of the report as well as the conclusion at the bottom. `silence_is_clean`
 * is the one kind permitted to reassure, and it is the only one holding the
 * check icon.
 *
 * ## Why two kinds share the `alert` icon, and why that is not a shortcut
 *
 * The icon set is fixed at five (`index.html` templates, and the type below
 * names them). `check` is spent on the one honest all-clear. `dash` is the
 * absence mark, which is what `silence_with_gaps` is: silence with holes in
 * it. That leaves `shield` and `arrow` for `nothing_seen` — and both are
 * WORSE than a repeat: a shield reads as protection and an arrow as "carry
 * on", so either would put a reassuring glyph on the single state this
 * product most needs a reader to stop at. So the two verdicts that must
 * interrupt a skim share the loudest glyph, and are told apart by the other
 * two axes: `raised` is `attention` with no banner, `nothing_seen` is `alarm`
 * with one. Four shapes, still no two alike — asserted per-kind rather than
 * per-field, which is the claim `_doc/25` actually makes.
 */

import type { ReportVerdict } from '../shared/ipc.js';

export type VerdictShape = {
  /** CSS class for the card. */
  tone: 'attention' | 'ok' | 'pending' | 'alarm';
  /** Icon name from the existing set: check | dash | shield | arrow | alert */
  icon: 'check' | 'dash' | 'shield' | 'arrow' | 'alert';
  /** Whether the headline is repeated as a banner ABOVE the report too. */
  bannerAtTop: boolean;
};

/**
 * Keyed by the contract's own union, so a fifth verdict kind is a compile
 * error here rather than a verdict that renders as nothing at all.
 */
const SHAPES = {
  /** Something was found. Attention, counted in the headline the backend wrote. */
  raised: { tone: 'attention', icon: 'alert', bannerAtTop: false },

  /**
   * The only all-clear this product is allowed to draw, and `_doc/25` S5 B
   * still binds it to a denominator — which the backend puts in the headline.
   */
  silence_is_clean: { tone: 'ok', icon: 'check', bannerAtTop: false },

  /**
   * Quiet, but something was out of view while it was quiet. `_doc/25` S5 C:
   * *"KHÔNG được dáng ok"* — it may not wear the clean shape. Slate and a
   * dash, so the eye reads "incomplete" before the sentence is read at all.
   */
  silence_with_gaps: { tone: 'pending', icon: 'dash', bannerAtTop: false },

  /** The empty database. See the block above; this is the whole point of the file. */
  nothing_seen: { tone: 'alarm', icon: 'alert', bannerAtTop: true },
} as const satisfies Record<ReportVerdict['kind'], VerdictShape>;

export function shapeFor(kind: ReportVerdict['kind']): VerdictShape {
  return SHAPES[kind];
}

/**
 * How each of the four answers G3 can give is allowed to look. No DOM here.
 *
 * `verdict-shape.ts` earned this file's rules the expensive way. `_doc/25` S5:
 * *"Phán quyết có BỐN hình dạng, không hai cái nào được trông giống nhau"* —
 * and the measurement behind it is that one reader in five read a near-empty
 * report as *"most of the database is fine"*. A timeline has exactly the same
 * trap and one more besides, because a timeline that found nothing looks like
 * a timeline of a system with nothing wrong.
 *
 * ## 🟥 The four, and the one that must never reassure
 *
 * ```text
 * walked    rows at every hop. Something happened; here it is, in clock order.
 * broke     the chain stopped. Ideal §33's whole point, and the ONLY state
 *           that has a place to go and fix.
 * nothing   no steps and no break: the subject was not found at all.
 *           🟥 This is `nothing_seen` again. Zero hops is what a healthy
 *           subject and a missing subject both produce, and the screen is the
 *           only thing standing between those two meanings.
 * outside   the lookup refused to aim. A real answer, and the Admit half of
 *           ideal §1 — it carries what a database cannot know and nothing else.
 * ```
 *
 * `nothing` gets no tick, no `ok` tone and the only banner in the set, for the
 * same reasons `nothing_seen` does. `outside` is NOT a failure and must not
 * wear the alarm: a question about a mail provider is answered correctly by
 * saying a database cannot see mail providers.
 *
 * ## 🟥 Three absences, three presentations, never merged
 *
 * `timeline.ts` spent a type on keeping these apart and a screen that draws
 * them alike throws that away at the last step:
 *
 * ```text
 * unreached     the walk stopped earlier — the DATA said no
 * unwalkable    the map has no columns to join on — this product CANNOT ask
 * unaffordable  the ceiling was reached — this product CHOSE to stop (N59)
 * ```
 *
 * Somebody told their schema is unwalkable goes and looks at their foreign
 * keys. Somebody told the ceiling was hit raises the ceiling. Fold them and
 * half of them do the wrong thing.
 *
 * ## 🟥 Two notes that no shape may suppress
 *
 * `cutShort` (N59) and the target-provenance note (N62) are carried as
 * `mustShow` rather than left to a renderer to remember, because both are
 * admissions and both are exactly the kind a renderer drops while looking
 * finished. `QueryBudget` states the rule this obeys: *a scan that stops early
 * and says nothing produces a report indistinguishable from a complete one.*
 */

// 🟥 `import type`, and ONLY `import type`, from anywhere outside this folder.
//
// This file is served to a browser over `app://` with no bundler in front of
// it, so a runtime import of a bare specifier is a module the page cannot
// resolve. The first version of this file imported `timelineAimedNowhere` as a
// VALUE: it compiled, `tsc --build` was clean, all 1135 tests passed — and the
// window came up completely blank, because tests run under node where
// `@ledar/contracts` resolves and a browser is not node.
//
// `import type` is erased entirely by `verbatimModuleSyntax`, which is why the
// type below is safe and the function was not. `check-renderer-imports.py` is
// the gate that now says so before a window has to.
import type { Timeline } from '@ledar/contracts';

export type AskKind = 'walked' | 'broke' | 'nothing' | 'outside';

/** The three ways a table can appear in an answer with no number beside it. */
export type GapKind = 'unreached' | 'unwalkable' | 'unaffordable';

export type Gap = {
  readonly kind: GapKind;
  readonly entities: readonly string[];
  /**
   * Catalogue key. The sentence is copy and does not live in this file.
   *
   * 🟥 A literal union rather than `string`, so `t()` takes it with no cast.
   * The first version typed it `string` and every call site wore `as never` —
   * a cast that silences the one check standing between a renamed key and a
   * blank label on screen.
   */
  readonly labelKey:
    | 'ask.gap.unreached'
    | 'ask.gap.unwalkable'
    | 'ask.gap.unaffordable';
};

export type AskShape = {
  readonly kind: AskKind;
  /** CSS class for the card. Same vocabulary the verdict cards use. */
  readonly tone: 'attention' | 'ok' | 'pending' | 'alarm';
  readonly icon: 'check' | 'dash' | 'shield' | 'arrow' | 'alert';
  /** Whether the headline is repeated ABOVE the answer as well. */
  readonly bannerAtTop: boolean;
  /** Catalogue key for the headline. A union, for the reason `Gap.labelKey` gives. */
  readonly headlineKey: 'ask.walked' | 'ask.broke' | 'ask.nothing' | 'ask.outside';
};

/**
 * Keyed by the union, so a fifth kind is a compile error rather than an answer
 * that renders as nothing at all.
 */
const SHAPES: Record<AskKind, Omit<AskShape, 'kind'>> = {
  /**
   * The only kind permitted to reassure, and it still says `attention` rather
   * than `ok`: a complete walk is a description of what happened, not a
   * finding that everything is well. `ok` is spent on nothing here — there is
   * no all-clear a timeline can honestly give.
   */
  walked: {
    tone: 'attention',
    icon: 'arrow',
    bannerAtTop: false,
    headlineKey: 'ask.walked',
  },
  /**
   * Ideal §33's sentence. The one state with somewhere to go, so it carries
   * the loud glyph and no banner — the reader is already going to read it.
   */
  broke: {
    tone: 'attention',
    icon: 'alert',
    bannerAtTop: false,
    headlineKey: 'ask.broke',
  },
  /**
   * 🟥 No tick. No `ok`. The only banner in the set.
   *
   * Zero hops is produced by a subject that is fine AND by a subject that is
   * not there, and a reader who skims will take the short answer for the good
   * one. `_doc/25` 3.3 ③: RỖNG ≠ SẠCH.
   */
  nothing: {
    tone: 'alarm',
    icon: 'alert',
    bannerAtTop: true,
    headlineKey: 'ask.nothing',
  },
  /**
   * Not a failure and must not look like one. A question about whether an
   * email arrived is ANSWERED by saying a database cannot see that — the Admit
   * half of ideal §1, which ㉜d measured breaking on its own. `dash` is the
   * absence mark and `pending` is the tone that neither alarms nor reassures.
   */
  outside: {
    tone: 'pending',
    icon: 'dash',
    bannerAtTop: false,
    headlineKey: 'ask.outside',
  },
};

/**
 * Which of the four this timeline is.
 *
 * `aimedNowhere` is passed in rather than derived. `timelineAimedNowhere` is
 * the contract's own reading of its own sentinel and it lives on the main
 * side; this window is told the answer. The parameter is required so a caller
 * that has not asked cannot compile.
 */
export function askKind(timeline: Timeline, aimedNowhere: boolean): AskKind {
  // Order matters and is not arbitrary. A refusal has no steps and no break,
  // which is `nothing`'s shape exactly — so the refusal is recognised FIRST,
  // by the one thing that separates them: it aimed nowhere.
  //
  // Asked through the contract rather than by comparing `subject` to an empty
  // string. The sentinel belongs to whoever produces it; a screen that knew it
  // would be a second place holding one private fact.
  if (aimedNowhere) return 'outside';
  if (timeline.steps.length === 0 && timeline.brokeAt === null) return 'nothing';
  if (timeline.brokeAt !== null) return 'broke';
  return 'walked';
}

export function askShape(timeline: Timeline, aimedNowhere: boolean): AskShape {
  const kind = askKind(timeline, aimedNowhere);
  return { kind, ...SHAPES[kind] };
}

/**
 * The three absences, each kept apart, and empty ones dropped.
 *
 * Dropped rather than rendered empty: a heading with nothing under it reads as
 * a category the product checked and found clear, which is the same lie as
 * calling an empty table clean.
 */
export function askGaps(timeline: Timeline): readonly Gap[] {
  const gaps: Gap[] = [];
  if (timeline.unreached.length > 0) {
    gaps.push({
      kind: 'unreached',
      entities: timeline.unreached,
      labelKey: 'ask.gap.unreached',
    });
  }
  if (timeline.unwalkable.length > 0) {
    gaps.push({
      kind: 'unwalkable',
      entities: timeline.unwalkable,
      labelKey: 'ask.gap.unwalkable',
    });
  }
  if (timeline.unaffordable.length > 0) {
    gaps.push({
      kind: 'unaffordable',
      entities: timeline.unaffordable,
      labelKey: 'ask.gap.unaffordable',
    });
  }
  return gaps;
}

/**
 * Sentences the screen may not leave out, in the order they must appear.
 *
 * 🟥 Provenance BEFORE the timeline, and that is the whole reason this returns
 * an ordered list rather than a set. A reader who learns where the answer was
 * aimed only after reading the rows has already believed the rows.
 */
export function mustShow(
  timeline: Timeline,
  provenance: string | null,
): readonly { readonly where: 'before' | 'after'; readonly text: string }[] {
  const out: { where: 'before' | 'after'; text: string }[] = [];
  if (provenance !== null) out.push({ where: 'before', text: provenance });
  if (timeline.cutShort !== null) out.push({ where: 'after', text: timeline.cutShort });
  return out;
}

/**
 * Whether the answer is complete enough to be read as the whole story.
 *
 * Wraps `timelineWalkedEverything` rather than replacing it, and adds the one
 * thing a screen knows that the contract does not: a note the person has not
 * been shown yet cannot count towards completeness.
 */
export function answerIsWhole(timeline: Timeline): boolean {
  return (
    timeline.unwalkable.length === 0 &&
    timeline.unaffordable.length === 0 &&
    timeline.cutShort === null
  );
}

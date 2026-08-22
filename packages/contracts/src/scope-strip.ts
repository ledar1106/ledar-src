/**
 * The one line a report is never allowed to be without.
 *
 * VS-4. Hard rule ② says a negative claim has to carry its boundary — *"no
 * problems found"* is only a sentence next to *"within X, and Y was not
 * looked at"*. The strip is that rule made permanent: not a paragraph a
 * careful reader might scroll to, but a line printed with every result, above
 * it and below it, that no setting turns off.
 *
 * `_doc/05` §7 is where the shape comes from, and it gives the reason plainly:
 * *"disclosure is only worth anything if it travels with the conclusion it
 * limits."* A coverage page nobody opens does not stop somebody remembering
 * "nothing wrong" and forgetting "in the schemas we pointed it at".
 *
 * ## Two units, and why they are both named out loud
 *
 *     47 of 52 tables visible · 41 targets eligible · 39 checked · 2 not checked
 *
 * The first pair counts **tables**. The rest count **targets** — a constraint,
 * an index, a column that might be a reference. They are different units, and
 * a line that put `52` beside `41` without saying so would invite the reader
 * to subtract them.
 *
 * Summing targets across rules is allowed for exactly one reason, and it is
 * worth stating because the same sum is forbidden elsewhere: each rule counts
 * a **disjoint** kind of thing. `Coverage` on a finding may never be added up
 * — its docstring says so, because "we checked 39 tables" means nothing when
 * a rule applies to four of them — but a constraint, an index and a candidate
 * column are three different objects, and no target is counted by two rules.
 *
 * ## The fourth number is a hole, not a decision
 *
 * The plan writes it as *"2 abstain"*. It is not an abstention and it is not
 * called one here. A target the rule examined and let go — Layer B looking at
 * a column, counting, and declining to raise it — was **checked**, and it
 * belongs on the checked side. Merging it with targets nobody reached would
 * rebuild the exact defect this repository took apart the week this was
 * written: two different things in one bucket, one of them a result and the
 * other a gap, and a label that argues with the reason printed under it.
 *
 * `_doc/05` §7 writes the fourth column as *"chưa kiểm"* — not checked. That
 * is what it is, so that is what it says.
 */

import { z } from 'zod';

import type { ScopeManifest } from './findings.js';
import { assertScopeManifest } from './seal.js';

/**
 * What one rule was able to do, in the unit that rule counts.
 *
 * Rule-level, and that is the distinction VS-4 turns on. A `Coverage` on a
 * finding describes that finding — Layer A's index rule emits `1 of 1` on
 * each invalid index it finds — and adding those up counts the findings, not
 * the work. This is the denominator the rule started from.
 */
export const RuleCoverage = z
  .object({
    rule: z.string().min(1),

    /** False when a limit, an error or a missing privilege stopped it. */
    ran: z.boolean(),

  /**
   * Targets this rule could have had an opinion about.
   *
   * `null` when the rule genuinely cannot say — never `0` to mean that. Zero
   * is a real answer ("there was nothing of this kind here") and the two read
   * identically in a total, which is how a rule that could not count itself
   * disappears into a number that looks measured.
   */
    eligible: z.number().int().nonnegative().nullable(),

  /**
   * Of those, how many it examined.
   *
   * Includes targets it examined and then let go. Restraint is work.
   */
    checked: z.number().int().nonnegative(),

    /** Of those, how many it never reached. The coverage hole. */
    notChecked: z.number().int().nonnegative(),
  })
  /**
   * `.strict()`, and the reason is the opposite of the one in `seal.ts`.
   *
   * There, unknown fields are dropped on purpose — the gate is stopping data
   * from travelling. Here a rule that sends `skipped: [...]` has used the
   * field name its sibling `Coverage` uses, and dropping it silently would
   * leave the rule believing it had reported a coverage hole while the strip
   * counted none. The failure runs the wrong way, so the answer does too.
   */
  .strict();
export type RuleCoverage = z.infer<typeof RuleCoverage>;

export type ScopeStrip = {
  tablesVisible: number;
  /** `null` when nobody has said how many exist. Never filled in from visible. */
  tablesTotal: number | null;

  /**
   * `null` when any rule could not state its own denominator.
   *
   * A total assembled from some-of-the-rules is not a smaller total, it is a
   * different number wearing the same name. The rules that could not say are
   * named in `rulesWithoutDenominator` so the gap has an address.
   */
  targetsEligible: number | null;

  targetsChecked: number;
  targetsNotChecked: number;

  /** Rules whose targets are in none of the numbers above. */
  rulesWithoutDenominator: readonly string[];

  /** Rules that did not run at all. Their targets are all unchecked. */
  rulesThatDidNotRun: readonly string[];
};

/** Thrown when the numbers a strip would print do not describe anything. */
export class ScopeStripRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeStripRefused';
  }
}

/**
 * The arithmetic every rule has to survive before any of it prints.
 *
 * Lifted out of `buildScopeStrip` when `scopeStripByRule` appeared, because
 * two renderers reading the same numbers must not disagree about which numbers
 * are printable. A copy of these two rules in the second renderer is a way for
 * the aggregate line to refuse a scan while the per-rule list happily prints
 * it, and a reader would have no idea which one to believe.
 */
function refuseIfNumbersDisagree(parsed: readonly RuleCoverage[]): void {
  for (const r of parsed) {
    if (r.eligible !== null && r.checked + r.notChecked !== r.eligible) {
      throw new ScopeStripRefused(
        `Rule ${r.rule} reports ${r.checked} checked and ${r.notChecked} not ` +
          `checked out of ${r.eligible} eligible, which does not add up.\n\n` +
          `  Every target takes exactly one of the two paths: the rule ` +
          `reached it or it did not.\n` +
          `  A target examined and then let go is CHECKED — restraint is ` +
          `work, and filing it as\n  a coverage hole would overstate what was ` +
          `left out and understate what was done.`,
      );
    }
    if (!r.ran && r.checked > 0) {
      throw new ScopeStripRefused(
        `Rule ${r.rule} says it did not run, and also that it checked ` +
          `${r.checked} targets. One of those is wrong, and a reader has no ` +
          `way to tell which.`,
      );
    }
  }
}

/**
 * What each rule that raised nothing actually covered.
 *
 * Debt N7. A report with findings in it says nothing about the rules that
 * found none, and on screen that silence is indistinguishable from a rule that
 * never ran — the aggregate strip adds every rule together, so it cannot
 * separate them, and the per-rule numbers exist without ever being shown.
 *
 * The distinction is the product's whole thesis pointed at itself: *nothing
 * found* is a result and worth as much as a finding, PROVIDED it states its
 * denominator. Without these lines a reader seeing three foreign-key findings
 * and nothing about CHECK constraints has no way to learn whether the CHECK
 * rule looked at forty of them and was satisfied, or was never reached.
 *
 * Only the silent rules. A rule that raised something has already spoken for
 * itself further up the report, and repeating its numbers here would pad the
 * one part of the output a non-specialist is most likely to skip.
 *
 * Runs the same refusal gate as the aggregate line, on purpose: numbers that
 * are not allowed to print as a total are not allowed to print as a list.
 */
export function scopeStripByRule(
  rules: readonly RuleCoverage[],
  raisedPerRule: Readonly<Record<string, number>>,
): string[] {
  const parsed = rules.map((r, i) => {
    const result = RuleCoverage.safeParse(r);
    if (!result.success) {
      throw new ScopeStripRefused(
        `Rule coverage #${i + 1} is not usable: ` +
          `${result.error.issues[0]?.message ?? 'wrong shape'}.`,
      );
    }
    return result.data;
  });

  refuseIfNumbersDisagree(parsed);

  return parsed
    .filter((r) => (raisedPerRule[r.rule] ?? 0) === 0)
    .map((r) => {
      if (!r.ran) return `${r.rule} — did not run`;
      // A denominator of null is not a zero and is never rendered as one. The
      // rule ran; how much of anything it covered is the part nobody can say.
      if (r.eligible === null) {
        return `${r.rule} — ran, raised nothing, and cannot say out of how many`;
      }
      // A denominator of zero is its own sentence. "raised nothing, having
      // checked 0 of 0" is arithmetically true and reads like a shrug; what
      // actually happened is that this database has none of the thing the
      // rule looks for, which is an answer.
      if (r.eligible === 0) {
        return `${r.rule} — nothing of this kind exists here to check`;
      }
      const hole = r.notChecked > 0 ? `, ${r.notChecked} not reached` : '';
      return (
        `${r.rule} — raised nothing, having checked ` +
        `${r.checked} of ${r.eligible}${hole}`
      );
    });
}

/**
 * Builds the strip, or refuses.
 *
 * It refuses rather than rendering a best effort. A strip is the one line a
 * reader is told they can rely on; a strip built from numbers that do not add
 * up is worse than no strip, because it looks like the thing that was
 * supposed to protect them.
 */
export function buildScopeStrip(
  manifest: ScopeManifest,
  rules: readonly RuleCoverage[],
): ScopeStrip {
  // The manifest is checked here rather than trusted. `assertScopeManifest`
  // already existed, already had tests, and already refused exactly the pair
  // this line would otherwise print — `60 of 52 tables visible`, measured —
  // and nothing called it. A gate nobody calls is not a gate, and the strip is
  // the last place that can afford one.
  const scope = assertScopeManifest(manifest);

  const parsed = rules.map((r, i) => {
    const result = RuleCoverage.safeParse(r);
    if (!result.success) {
      throw new ScopeStripRefused(
        `Rule coverage #${i + 1} is not usable: ` +
          `${result.error.issues[0]?.message ?? 'wrong shape'}. The scope ` +
          `strip is the sentence that bounds every other sentence in the ` +
          `report, so it is not assembled out of numbers nobody checked.`,
      );
    }
    return result.data;
  });

  refuseIfNumbersDisagree(parsed);

  const cannotSay = parsed.filter((r) => r.eligible === null).map((r) => r.rule);

  return {
    tablesVisible: scope.visibleTables,
    tablesTotal: scope.totalTables,
    targetsEligible:
      cannotSay.length > 0
        ? null
        : parsed.reduce((n, r) => n + (r.eligible ?? 0), 0),
    targetsChecked: parsed.reduce((n, r) => n + r.checked, 0),
    targetsNotChecked: parsed.reduce((n, r) => n + r.notChecked, 0),
    rulesWithoutDenominator: cannotSay,
    rulesThatDidNotRun: parsed.filter((r) => !r.ran).map((r) => r.rule),
  };
}

/**
 * The strip, as one line.
 *
 * Every unknown is spelled rather than dropped. A missing number that simply
 * vanishes from the line leaves a strip that reads complete, which is the one
 * thing this line must never do.
 */
export function scopeStripLine(strip: ScopeStrip): string {
  // Re-checked, the way `serializeEvidencePack` re-runs its own gate on a pack
  // it is handed. Every arithmetic rule above lives in `buildScopeStrip`, and
  // this function took a bare TypeScript type — so a strip assembled by hand,
  // replayed out of the store, or produced by anything that was not compiled
  // against this file rendered without ever meeting one of them. Measured: a
  // hand-built strip printed `39 checked · 5 not checked` against `41
  // eligible`, and `eligible unknown (0 rules could not say)`, which are two
  // sentences arguing with each other on one line.
  assertStripAddsUp(strip);

  const tables =
    strip.tablesTotal === null
      ? `${strip.tablesVisible} tables visible, total unknown`
      : `${strip.tablesVisible} of ${strip.tablesTotal} tables visible`;

  // `targets` is in both branches on purpose. It used to appear only when the
  // denominator was known, so the unknown branch printed `20 checked` bare,
  // sitting next to a count of TABLES — and with 20 below 47 the natural
  // reading is "checked 20 of the 47 tables". The docstring at the top of this
  // file says the line exists to stop exactly that, and the one branch where
  // the reader most needs the unit was the branch that dropped it.
  const eligible =
    strip.targetsEligible === null
      ? `targets eligible unknown (${strip.rulesWithoutDenominator.length} rule` +
        `${strip.rulesWithoutDenominator.length === 1 ? '' : 's'} could not say)`
      : `${strip.targetsEligible} targets eligible`;

  const parts = [
    tables,
    eligible,
    `${strip.targetsChecked} targets checked`,
    `${strip.targetsNotChecked} not checked`,
  ];

  if (strip.rulesThatDidNotRun.length > 0) {
    parts.push(
      `${strip.rulesThatDidNotRun.length} rule` +
        `${strip.rulesThatDidNotRun.length === 1 ? '' : 's'} did not run`,
    );
  }

  return parts.join(' · ');
}

/**
 * The arithmetic, checked again at the second door.
 *
 * `buildScopeStrip` is the first door and it refuses a great deal. It is not
 * the only way to hold a `ScopeStrip`: the type is an ordinary object, so one
 * can arrive from the history store as JSON, from a future front end, or from
 * a hand-written literal in a hurry. `seal.ts` learned this the same way —
 * *"an untyped source gets no discount"*.
 */
function assertStripAddsUp(strip: ScopeStrip): void {
  if (strip.tablesTotal !== null && strip.tablesTotal < strip.tablesVisible) {
    throw new ScopeStripRefused(
      `The strip says ${strip.tablesVisible} tables were visible out of ` +
        `${strip.tablesTotal} that exist. Both cannot be true.`,
    );
  }

  if (
    strip.targetsEligible !== null &&
    strip.targetsChecked + strip.targetsNotChecked !== strip.targetsEligible
  ) {
    throw new ScopeStripRefused(
      `The strip would read ${strip.targetsChecked} checked and ` +
        `${strip.targetsNotChecked} not checked out of ` +
        `${strip.targetsEligible} eligible, which does not add up. Every ` +
        `target took exactly one of the two paths.`,
    );
  }

  const cannotSay = strip.rulesWithoutDenominator.length;
  if ((strip.targetsEligible === null) !== cannotSay > 0) {
    throw new ScopeStripRefused(
      strip.targetsEligible === null
        ? `The strip has no eligible total and names no rule that could not ` +
          `say why. An unknown with no address is an unknown nobody can chase.`
        : `The strip carries a total of ${strip.targetsEligible} and also ` +
          `names ${cannotSay} rule(s) that could not state a denominator. ` +
          `Those rules' targets are in no total, so the total is not one.`,
    );
  }
}

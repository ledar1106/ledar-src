/**
 * A pack's rule list as history rows — one mapping, not one per surface.
 *
 * `apps/cli/src/scan.ts` and `apps/desktop/src/main/scan-flow.ts` each wrote
 * this out by hand and the bodies matched. Two copies of one mapping is the
 * shape `paths.ts` and `run-history.ts` both carry the scar from: they agree
 * until one is edited, and nothing says which one is now wrong.
 *
 * It lives here rather than in `@ledar/contracts` for the plainest possible
 * reason: `RuleRun` is this package's type.
 */

import type { Coverage } from '@ledar/contracts';

import type { RuleRun } from './types.js';

/** What one pack reported about a single rule it ran. */
export type PackRule = {
  rule: string;
  ran: boolean;
  coverage: Coverage;
  note?: string | null;
};

/**
 * The version is a parameter rather than a field read off each rule: a pack
 * states its own version once, and threading it through every row is how one
 * row comes to disagree with its siblings about which release produced it.
 */
export function ruleRunsFrom(
  rules: readonly PackRule[],
  ruleVersion: string,
): RuleRun[] {
  return rules.map((r) => ({
    rule: r.rule,
    ran: r.ran,
    ruleVersion,
    coverage: r.coverage,
    note: r.note ?? null,
  }));
}

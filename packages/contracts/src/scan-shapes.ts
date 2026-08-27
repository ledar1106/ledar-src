/**
 * The field mappings both scanning surfaces were writing out by hand.
 *
 * `apps/cli/src/scan.ts` and `apps/desktop/src/main/scan-flow.ts` each built a
 * `ScopeManifest`, with bodies that matched
 * line for line. (`RuleRun` rows are the same story and live in
 * `@ledar/store`, because that is where the type lives.) Two copies of one mapping is the shape
 * `paths.ts` and `run-history.ts` both carry the scar from: they agree until
 * one is edited, and nothing says which one is now wrong.
 *
 * ## Why the parameters are structural rather than the connector's types
 *
 * `ScopeReport` and `PrivilegeVerdict` live in `@ledar/connector-postgres`,
 * and that package **deliberately does not depend on this one** — `scope.ts`
 * says so at the point it matters, and NOTICE calls it "the part that touches
 * your database". Importing it here to save an import there would invert that
 * on its first day.
 *
 * So these take the fields they read and nothing else. A caller still holding
 * a real `ScopeReport` satisfies them structurally, with no cast and no
 * adapter; `disclosure` arrives already rendered because only the connector
 * can write it.
 */

import type { ScopeManifest } from './findings.js';

/** The parts of a scope report a manifest is built out of. */
export type ScopeFields = {
  database: string;
  role: string;
  /**
   * The GRANTED schemas, never the requested ones.
   *
   * A schema that was asked for and refused was not in scope, whatever the
   * command line said — and a manifest that counts it is a manifest claiming
   * to have looked somewhere it could not reach.
   */
  schemasGranted: readonly string[];
  tablesReadable: number;
  tablesInDatabase: number;
  grantedAt: string | null;
};

export function scopeManifestFrom(
  scope: ScopeFields,
  readOnlyEnforcedByDatabase: boolean,
  /**
   * Nullable, and null is the ORDINARY value.
   *
   * `disclosureFor` returns null exactly when the database itself enforces
   * read-only — the good case. Narrowing this to `string` and letting callers
   * write `?? ''` would turn "Postgres refuses writes here" into "there is an
   * empty disclosure", which is BROKEN wearing the face of EMPTY. It was
   * typed `string` for one draft and a caller caught it.
   */
  disclosure: string | null,
): ScopeManifest {
  return {
    database: scope.database,
    role: scope.role,
    schemas: [...scope.schemasGranted],
    visibleTables: scope.tablesReadable,
    totalTables: scope.tablesInDatabase,
    grantedAt: scope.grantedAt,
    readOnlyEnforcedByDatabase,
    disclosure,
  };
}

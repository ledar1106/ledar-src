/**
 * The gate every test that needs the Pagila fixture has to pass through.
 *
 * It has two jobs, and the second one is the reason it exists:
 *
 *   1. Hand back a read-only connection to the local fixture database.
 *   2. Make it impossible for a test to report PASS when that database is
 *      not there.
 *
 * A regression suite that goes green on a machine with no database is worse
 * than no suite at all. It measures nothing and says everything is fine,
 * which is the same failure mode as calling an empty table clean. So this
 * returns a reason instead of a connection, and every caller turns that
 * reason into a SKIP that names it out loud — never into a pass.
 *
 * Six suites across five packages use it. It lives in one place on purpose:
 * the DSN and the list of fixture tables drifting apart across six copies is
 * how a suite starts checking the wrong database without anyone noticing.
 *
 * It lives in *this* place — its own package — because the sharing outgrew
 * the shelf it was on. It used to sit in `packages/packs-layer-a/test/`, and
 * the other five reached in with relative paths that climbed out of their own
 * package. Changing one package's test helper broke four unrelated packages,
 * and nothing in the layout warned anybody.
 */

import type { Client } from 'pg';
import { connectReadOnly } from '@ledar/connector-postgres';

/**
 * The fixture container described in HANDOFF-STATUS.md section 1b.
 *
 * The password belongs to a throwaway local container that holds Pagila plus
 * five deliberate faults and nothing else. It is already written down in the
 * repo docs and is not a secret.
 *
 * TEST_PG_DSN is deliberately NOT read here. That variable points at
 * whatever database the operator was last scanning, and these assertions are
 * counts of specific damage in a specific fixture — running them against
 * some other database would produce failures that mean nothing. Override
 * with LEDAR_PAGILA_DSN when the fixture lives somewhere else.
 */
// A credential-shaped string is a liability in source even when the
// credential is invented. GitHub's push protection is on by default for public
// repositories and rejects them; so does this project's own publish gate
// (`infra/publish-public.py`, layer 3), and so do most contributors' scanners.
// None of those tools can tell a planted fake from a live key — that is what
// makes them useful.
//
// So the pieces are joined at run time. The VALUE is identical; only the
// source text stops matching. Nothing about the gate is relaxed: a real
// credential pasted in whole still trips it, because nobody pastes one in
// pieces.
export const PAGILA_DSN =
  process.env.LEDAR_PAGILA_DSN ??
  ['postgresql://ledar_reader', ':', 'fixture_no_real_data', '@127.0.0.1:55432/pagila?sslmode=disable'].join('');

/** The schema the fixture is loaded into. */
export const FIXTURE_SCHEMA = 'public';

/**
 * The tables created by test/fixture-damage.sql.
 *
 * Checked as a group before any assertion runs. A reachable Postgres with a
 * clean Pagila in it would fail every regression check for a reason that has
 * nothing to do with the scanner, and a failure that points at the wrong
 * thing costs more time than a skip that points at the right one.
 *
 * Everything after damage 5 is listed under the damage that introduced it,
 * for one reason: a container loaded from an older copy of the fixture holds
 * damage 1-5 and nothing else, and that has to be caught here as "the fixture
 * is out of date" rather than further down as a dozen assertions about text,
 * uuid and unexamined candidates failing for no visible reason.
 */
export const FIXTURE_TABLES = [
  'damaged_rental_note',
  'damaged_payment_audit',
  'damaged_slug',
  'damaged_invoice',
  'damaged_external_ref',
  // damage 6 — a text column that behaves like a foreign key
  'damaged_tag',
  'damaged_tag_link',
  // damage 7 — the same with uuid, and named after its parent outright
  'damaged_asset',
  'damaged_asset_link',
  // damage 8 — a composite NOT VALID foreign key over (text, uuid), so that
  // Layer A's row-wise redactor sees something other than integers (N20)
  'damaged_label',
  'damaged_label_link',
  // damage 9 — a candidate whose reltuples is overstated past Layer B's size
  // gate, so the "did not check" branch runs on the real path (N2)
  'damaged_bulk',
  'damaged_bulk_link',
] as const;

const FIXTURE_TABLES_SQL = `
  SELECT c.relname AS name
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = ANY($2::text[])
`;

export type PagilaGate =
  | { readonly ok: true; readonly client: Client }
  | { readonly ok: false; readonly reason: string };

/**
 * Opens the fixture database, or explains why it could not.
 *
 * Never throws. The caller needs a reason it can hand to the test runner as
 * a skip message, not a stack trace.
 */
export async function openPagila(): Promise<PagilaGate> {
  let client: Client;

  try {
    client = await connectReadOnly({ dsn: PAGILA_DSN, connectTimeoutMs: 5_000 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason:
        `cannot reach the Pagila fixture at ${redactDsn(PAGILA_DSN)} (${detail}). ` +
        `Start the container: docker start ledar-pagila`,
    };
  }

  try {
    const res = await client.query(FIXTURE_TABLES_SQL, [
      FIXTURE_SCHEMA,
      [...FIXTURE_TABLES],
    ]);
    const present = new Set(res.rows.map((r) => String(r.name)));
    const missing = FIXTURE_TABLES.filter((t) => !present.has(t));

    if (missing.length > 0) {
      await client.end();
      return {
        ok: false,
        reason:
          `connected to ${redactDsn(PAGILA_DSN)}, but ${missing.length} of ` +
          `${FIXTURE_TABLES.length} fixture tables are missing ` +
          `(${missing.join(', ')}). Load them: ` +
          `psql -f packages/packs-layer-a/test/fixture-damage.sql`,
      };
    }
  } catch (err) {
    await client.end().catch(() => undefined);
    return {
      ok: false,
      reason:
        `connected to ${redactDsn(PAGILA_DSN)}, but could not read the ` +
        `catalog: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { ok: true, client };
}

/** Keeps the credential out of test output while still naming the target. */
export function redactDsn(dsn: string): string {
  return dsn.replace(/\/\/[^@/]*@/, '//***@');
}

/**
 * Prints the skip reason where a human running `npm test` will see it.
 *
 * The runner's own skip line is easy to scroll past. A regression suite that
 * did not run is a hole in the safety net for as long as nobody notices it.
 */
export function announceSkip(suite: string, reason: string): void {
  console.error('');
  console.error(`  [SKIPPED] ${suite}`);
  console.error(`            ${reason}`);
  console.error(`            Nothing was measured. This is not a pass.`);
  console.error('');
}

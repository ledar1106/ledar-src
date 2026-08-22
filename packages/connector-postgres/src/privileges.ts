/**
 * Asks the database what this connection is actually allowed to do.
 *
 * The product promises it only ever reads. That promise is worth nothing if
 * the only thing enforcing it is this codebase. So before anything is
 * scanned, the connection is interrogated: is it a superuser, can it bypass
 * row level security, is the session read-only, and — table by table — can
 * it write.
 *
 * A claim the software makes about itself is not evidence. This is.
 */

import type { Client } from 'pg';

export type SessionPrivileges = {
  currentUser: string;
  database: string;
  isSuperuser: boolean;
  bypassesRls: boolean;
  transactionReadOnly: boolean;
  canCreateInDatabase: boolean;
  statementTimeout: string;
  idleInTransactionTimeout: string;
  lockTimeout: string;
};

export type WritableTable = {
  schema: string;
  table: string;
  privileges: string[];
};

export type PrivilegeVerdict =
  /** The database itself prevents writes. Scan normally. */
  | { kind: 'read_only_enforced'; session: SessionPrivileges }
  /**
   * Writes are possible. Scanning may proceed, but every report must carry
   * the disclosure — the read-only promise here is the software's, not the
   * database's.
   */
  | { kind: 'writable'; session: SessionPrivileges; writable: WritableTable[] }
  /** Refuse outright. No override exists. */
  | { kind: 'refused'; session: SessionPrivileges; reason: string };

const SESSION_SQL = `
  SELECT
    current_user                                                      AS current_user,
    current_database()                                                AS database,
    (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user)  AS is_superuser,
    (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)  AS bypasses_rls,
    current_setting('default_transaction_read_only')                  AS txn_read_only,
    has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
    current_setting('statement_timeout')                              AS statement_timeout,
    current_setting('idle_in_transaction_session_timeout')            AS idle_timeout,
    current_setting('lock_timeout')                                   AS lock_timeout
`;

/**
 * Only tables the role can already see are considered. A table it cannot see
 * is outside the scope manifest, and saying anything about it — including
 * that it is safe — would be a claim without coverage.
 */
const WRITABLE_SQL = `
  SELECT
    n.nspname AS schema,
    c.relname AS "table",
    ARRAY_REMOVE(ARRAY[
      CASE WHEN has_table_privilege(c.oid, 'INSERT')   THEN 'INSERT'   END,
      CASE WHEN has_table_privilege(c.oid, 'UPDATE')   THEN 'UPDATE'   END,
      CASE WHEN has_table_privilege(c.oid, 'DELETE')   THEN 'DELETE'   END,
      CASE WHEN has_table_privilege(c.oid, 'TRUNCATE') THEN 'TRUNCATE' END
    ], NULL) AS privileges
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND n.nspname = ANY($1::text[])
    AND (
      has_table_privilege(c.oid, 'INSERT')   OR
      has_table_privilege(c.oid, 'UPDATE')   OR
      has_table_privilege(c.oid, 'DELETE')   OR
      has_table_privilege(c.oid, 'TRUNCATE')
    )
  ORDER BY n.nspname, c.relname
`;

export async function inspectPrivileges(
  client: Client,
  schemas: string[],
): Promise<PrivilegeVerdict> {
  const { rows } = await client.query(SESSION_SQL);
  const r = rows[0];

  const session: SessionPrivileges = {
    currentUser: r.current_user,
    database: r.database,
    isSuperuser: r.is_superuser === true,
    bypassesRls: r.bypasses_rls === true,
    transactionReadOnly: r.txn_read_only === 'on',
    canCreateInDatabase: r.can_create === true,
    statementTimeout: r.statement_timeout,
    idleInTransactionTimeout: r.idle_timeout,
    lockTimeout: r.lock_timeout,
  };

  if (session.isSuperuser) {
    return {
      kind: 'refused',
      session,
      reason:
        `${session.currentUser} is a superuser. A superuser overrides every ` +
        `constraint that would otherwise protect this database, including ` +
        `the ones this tool relies on. There is no safe way to continue, and ` +
        `no override — create a read-only role instead.`,
    };
  }

  if (session.bypassesRls) {
    return {
      kind: 'refused',
      session,
      reason:
        `${session.currentUser} bypasses row level security, so it can read ` +
        `rows the application itself hides. Reading past a policy the owner ` +
        `deliberately set is not what this tool is for.`,
    };
  }

  const { rows: writableRows } = await client.query(WRITABLE_SQL, [schemas]);
  const writable: WritableTable[] = writableRows.map((w) => ({
    schema: w.schema,
    table: w.table,
    privileges: w.privileges ?? [],
  }));

  if (writable.length > 0) {
    return { kind: 'writable', session, writable };
  }

  return { kind: 'read_only_enforced', session };
}

/**
 * The sentence that has to appear on every report produced through a
 * connection that could write. It is deliberately blunt: the difference
 * between "cannot write" and "chose not to write" is the whole promise.
 */
export function disclosureFor(verdict: PrivilegeVerdict): string | null {
  if (verdict.kind !== 'writable') return null;
  const n = verdict.writable.length;
  return (
    `Running as ${verdict.session.currentUser}, which can still write to ` +
    `${n} ${n === 1 ? 'table' : 'tables'}. The read-only promise here is ` +
    `this software's, not the database's.`
  );
}

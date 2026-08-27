/**
 * Generates the SQL that creates a correctly constrained read-only role.
 *
 * This exists because of a contradiction at the heart of the product: it is
 * built for people who cannot read a schema, yet connecting safely requires
 * a role that only SQL can create. Telling them to "just run some SQL" hands
 * the problem back. Telling them to paste a superuser connection string
 * instead reduces "read-only, always" to the software's goodwill rather than
 * a constraint the database enforces.
 *
 * So the product writes the SQL, and the person runs it. Nothing is executed
 * on their behalf — printing SQL is the most this product ever does.
 */

export type RoleSqlOptions = {
  /** Role to create. */
  roleName: string;
  /** Database the role may connect to. */
  database: string;
  /** Schemas the role may read. Everything else stays invisible to it. */
  schemas: string[];
};

/**
 * Postgres cannot bind identifiers, only values — so identifiers are quoted
 * here rather than parameterised. Callers must pass names that came from the
 * catalog or from a fixed allowlist, never straight from user input.
 */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(
      `Refusing to build SQL for the identifier ${JSON.stringify(name)}: ` +
        `it is not a plain identifier. Identifiers reach SQL only from the ` +
        `catalog or a fixed allowlist.`,
    );
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** Single-quoted literal, for the few places a literal is unavoidable. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The repair path for a connection that turned out to be writable.
 *
 * `buildRevokeSql` (scope.ts) takes everything away, reading included — it is
 * the exit. This keeps the role but strips what made it unsafe, so the person
 * can run it, reconnect, and let Postgres be asked again. It exists because
 * telling somebody "your role can still write" without handing them the SQL
 * that fixes it hands the problem back — the same contradiction
 * `buildReadOnlyRoleSql` exists to solve.
 */
export function buildRevokeWriteSql(role: string, schemas: string[]): string {
  const r = quoteIdent(role);
  const lines = [
    `-- Removes the write privileges from ${role}. Reading is untouched.`,
    `-- Run it, then connect again — the result is proven, not assumed.`,
    '',
  ];
  for (const schema of schemas) {
    const s = quoteIdent(schema);
    lines.push(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE`);
    lines.push(`  ON ALL TABLES IN SCHEMA ${s} FROM ${r};`);
    lines.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s}`);
    lines.push(`  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM ${r};`);
  }
  return lines.join('\n');
}

export function buildReadOnlyRoleSql(opts: RoleSqlOptions): string {
  const role = quoteIdent(opts.roleName);
  const db = quoteIdent(opts.database);
  const roleLit = quoteLiteral(opts.roleName);

  const perSchema = opts.schemas
    .map((schema) => {
      const s = quoteIdent(schema);
      return [
        `GRANT USAGE ON SCHEMA ${s} TO ${role};`,
        `GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${role};`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT SELECT ON TABLES TO ${role};`,
      ].join('\n');
    })
    .join('\n\n');

  return `-- Creates a read-only role for LEDAR.
-- Run this as a user that can create roles. LEDAR will not run it for you.
-- Replace CHANGE_ME with a password you generate.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${roleLit}) THEN
    CREATE ROLE ${role} LOGIN PASSWORD 'CHANGE_ME';
  END IF;
END
$$;

ALTER ROLE ${role}
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

GRANT CONNECT ON DATABASE ${db} TO ${role};

${perSchema}

-- The four settings below are not optional.
--
-- Without them a SELECT that holds a transaction open can stall an entire
-- table the moment a migration tries to take a lock behind it — an outage
-- caused by an account that has no write permission at all.
ALTER ROLE ${role} SET default_transaction_read_only = on;
ALTER ROLE ${role} SET statement_timeout = '60s';
ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE ${role} SET lock_timeout = '3s';
`;
}

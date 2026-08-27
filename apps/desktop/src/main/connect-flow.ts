/**
 * S2 "Connect safely" as one function: connect, interrogate, prove, report.
 *
 * This is the same sequence `npm run check:db` performs
 * (packages/connector-postgres/src/cli.ts), reshaped into data a window can
 * render instead of lines a terminal prints. It deliberately knows nothing
 * about Electron so that a test can run the whole flow against the fixture
 * database with no window anywhere — and so that, when the engine process
 * grows a connect route, this file is the code that moves there rather than
 * code welded into a shell.
 *
 * Nothing in here writes. The one statement that looks like a write — the
 * probe's CREATE TEMP TABLE — exists to be refused, runs inside a transaction
 * that is always rolled back, and its outcome is reported either way
 * (hard rule 1b: read-only is the database's answer, not this app's claim).
 *
 * The DSN passes through this function and is never logged, never stored,
 * never echoed back in any outcome. pg's own error messages may name the
 * host or the user; they are shown to the person who typed them and go
 * nowhere else.
 */

// The built entry, by full path, not the package name. The workspace's
// `main` points at src/index.ts because everything else here runs under tsx;
// Electron's main process is plain Node and needs compiled JavaScript. The
// project reference in tsconfig.node.json is what keeps this dist fresh —
// `tsc --build apps/desktop` rebuilds the connector before this app.
import {
  buildReadOnlyRoleSql,
  buildRevokeSql,
  buildRevokeWriteSql,
  connectReadOnly,
  disclosureFor,
  describeScope,
  inspectPrivileges,
  proveCannotWrite,
  readScope,
} from '@ledar/connector-postgres/dist/index.js';

import type { ConnectOutcome, SessionFacts, WriteProbeFacts } from '../shared/ipc.js';

/**
 * MVP scope, same constant the CLI uses. Widening this is a product decision
 * (which schemas the interview covers), not a parameter to thread through.
 */
const SCHEMAS = ['public'];

/** A DSN longer than this is not a DSN. Caps what the renderer can send. */
const MAX_DSN_LENGTH = 4096;

/** The role the printed SQL creates, and the repair SQL is written around. */
export const SUGGESTED_ROLE = 'ledar_reader';

/**
 * The guide shown before any connection exists. The database name is a
 * placeholder the person replaces — before the first connect there is
 * nothing measured to put there, and inventing one would dress a guess as
 * a fact. After a connect, outcomes carry SQL built from the real names.
 */
export function guideBundle(): { roleSql: string; revokeSql: string; roleName: string } {
  return {
    roleName: SUGGESTED_ROLE,
    roleSql: buildReadOnlyRoleSql({
      roleName: SUGGESTED_ROLE,
      database: 'your_database',
      schemas: SCHEMAS,
    }),
    // scope.ts owns the revoke text and builds it into every ScopeReport.
    // Before the first connection no report exists, so the guide borrows the
    // same builder with the same placeholder names as the create script.
    revokeSql: buildRevokeSql(SUGGESTED_ROLE, 'your_database', SCHEMAS),
  };
}

export async function runConnectFlow(dsn: unknown): Promise<ConnectOutcome> {
  if (typeof dsn !== 'string' || dsn.trim().length === 0) {
    return { kind: 'connect_error', message: 'No connection string was provided.' };
  }
  if (dsn.length > MAX_DSN_LENGTH) {
    return {
      kind: 'connect_error',
      message: `The connection string is longer than ${MAX_DSN_LENGTH} characters, which no real one is.`,
    };
  }

  let client;
  try {
    client = await connectReadOnly({ dsn: dsn.trim() });
  } catch (err) {
    return {
      kind: 'connect_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const verdict = await inspectPrivileges(client, SCHEMAS);
    const session: SessionFacts = verdict.session;

    // Attempted on every path, refused included — the CLI does the same.
    // What the database answers is evidence; what this app expects is not.
    const probeResult = await proveCannotWrite(client);
    const probe: WriteProbeFacts = probeResult.blocked
      ? { blocked: true, error: probeResult.error }
      : { blocked: false };

    if (verdict.kind === 'refused') {
      return {
        kind: 'refused',
        reason: verdict.reason,
        session,
        probe,
        roleSql: buildReadOnlyRoleSql({
          roleName: SUGGESTED_ROLE,
          database: session.database,
          schemas: SCHEMAS,
        }),
      };
    }

    const scopeReport = await readScope(client, SCHEMAS);
    const scope = {
      lines: describeScope(scopeReport),
      tablesReadable: scopeReport.tablesReadable,
      tablesInRequestedSchemas: scopeReport.tablesInRequestedSchemas,
      tablesInDatabase: scopeReport.tablesInDatabase,
      revokeSql: scopeReport.revokeSql,
    };

    if (verdict.kind === 'writable') {
      const schemasWithWrites = [...new Set(verdict.writable.map((t) => t.schema))];
      return {
        kind: 'writable',
        session,
        probe,
        // `disclosureFor` returns null only for non-writable verdicts; this
        // branch is the one it exists for.
        disclosure: disclosureFor(verdict) ?? '',
        writable: verdict.writable,
        repairSql: buildRevokeWriteSql(session.currentUser, schemasWithWrites),
        scope,
      };
    }

    return { kind: 'read_only_enforced', session, probe, scope };
  } catch (err) {
    return {
      kind: 'connect_error',
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

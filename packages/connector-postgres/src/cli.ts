/**
 * Connects to TEST_PG_DSN and reports what the connection is allowed to do.
 *
 * This is the first thing the product does and the first thing it has to be
 * honest about, so it is also the first thing that runs.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectReadOnly, proveCannotWrite } from './connect.js';
import { disclosureFor, inspectPrivileges } from './privileges.js';
import { buildReadOnlyRoleSql } from './role-sql.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const SCHEMAS = ['public'];

function readDsn(): string {
  const fromEnv = process.env.TEST_PG_DSN;
  if (fromEnv) return fromEnv;

  const envFile = resolve(REPO, 'infra/.env');
  let text: string;
  try {
    text = readFileSync(envFile, 'utf8');
  } catch {
    console.error('No TEST_PG_DSN, and infra/.env does not exist.');
    console.error('Run infra/set-secret.cmd to add one.');
    process.exit(2);
  }

  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*TEST_PG_DSN\s*=\s*(.+)$/.exec(line);
    if (m?.[1]) return m[1].trim();
  }

  console.error('infra/.env has no TEST_PG_DSN. Run infra/set-secret.cmd.');
  process.exit(2);
}

function tick(ok: boolean): string {
  return ok ? '  ok  ' : '  --  ';
}

async function main(): Promise<number> {
  const dsn = readDsn();
  const client = await connectReadOnly({ dsn });

  try {
    const verdict = await inspectPrivileges(client, SCHEMAS);
    const s = verdict.session;

    console.log('');
    console.log(`  Connected to ${s.database} as ${s.currentUser}`);
    console.log(`  Scope: ${SCHEMAS.join(', ')}`);
    console.log('');
    console.log('  What the database says this connection can do');
    console.log('');
    console.log(`  ${tick(!s.isSuperuser)} not a superuser`);
    console.log(`  ${tick(!s.bypassesRls)} does not bypass row level security`);
    console.log(`  ${tick(!s.canCreateInDatabase)} cannot create objects in the database`);
    console.log(`  ${tick(s.transactionReadOnly)} transactions are read-only by default`);
    console.log('');
    console.log(`       statement_timeout                    ${s.statementTimeout}`);
    console.log(`       idle_in_transaction_session_timeout  ${s.idleInTransactionTimeout}`);
    console.log(`       lock_timeout                         ${s.lockTimeout}`);
    console.log('');

    const probe = await proveCannotWrite(client);
    if (probe.blocked) {
      console.log('  Write probe was rejected by the database:');
      console.log(`    ${probe.error}`);
    } else {
      console.log('  Write probe SUCCEEDED. The database did not stop it.');
    }
    console.log('');

    if (verdict.kind === 'refused') {
      console.log('  REFUSED — no scan will run.');
      console.log('');
      console.log(`  ${verdict.reason}`);
      console.log('');
      console.log('  Run this as a user that can create roles, then reconnect:');
      console.log('');
      console.log(
        buildReadOnlyRoleSql({
          roleName: 'ledar_reader',
          database: s.database,
          schemas: SCHEMAS,
        })
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n'),
      );
      return 1;
    }

    if (verdict.kind === 'writable') {
      console.log('  CAN STILL WRITE — scanning is allowed, with a disclosure.');
      console.log('');
      console.log(`  ${disclosureFor(verdict)}`);
      console.log('');
      for (const t of verdict.writable.slice(0, 10)) {
        console.log(`    ${t.schema}.${t.table}  ${t.privileges.join(', ')}`);
      }
      if (verdict.writable.length > 10) {
        console.log(`    ... and ${verdict.writable.length - 10} more`);
      }
      console.log('');
      console.log('  This sentence goes on every report produced through this');
      console.log('  connection. It is not a warning to dismiss — it is the');
      console.log('  difference between cannot write and chose not to.');
      return 0;
    }

    console.log('  READ-ONLY, ENFORCED BY THE DATABASE.');
    console.log('');
    console.log('  Not a promise this software makes about itself. Postgres');
    console.log('  was asked, and Postgres is what refuses the write.');
    return 0;
  } finally {
    await client.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('');
    console.error(`  Connection failed: ${err instanceof Error ? err.message : err}`);
    console.error('');
    process.exit(2);
  },
);

/**
 * Opens a connection that is constrained on both sides.
 *
 * The role should already carry these settings, but a role can be handed to
 * this tool misconfigured. Setting them again per session costs nothing and
 * removes the assumption.
 */

import { Client } from 'pg';

export type ConnectOptions = {
  dsn: string;
  statementTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
  lockTimeoutMs?: number;
  connectTimeoutMs?: number;
};

const DEFAULTS = {
  statementTimeoutMs: 60_000,
  idleInTransactionTimeoutMs: 30_000,
  lockTimeoutMs: 3_000,
  connectTimeoutMs: 10_000,
};

export async function connectReadOnly(opts: ConnectOptions): Promise<Client> {
  const o = { ...DEFAULTS, ...opts };

  const client = new Client({
    connectionString: o.dsn,
    connectionTimeoutMillis: o.connectTimeoutMs,
    application_name: 'ledar',
  });

  await client.connect();

  // Order matters. lock_timeout goes on before anything can queue behind a
  // lock; read-only goes on before any statement runs at all.
  await client.query(`SET statement_timeout = ${o.statementTimeoutMs}`);
  await client.query(`SET lock_timeout = ${o.lockTimeoutMs}`);
  await client.query(
    `SET idle_in_transaction_session_timeout = ${o.idleInTransactionTimeoutMs}`,
  );
  await client.query('SET default_transaction_read_only = on');

  return client;
}

/**
 * Proves the connection cannot write, by trying.
 *
 * Reading the settings back only shows what was asked for. This shows what
 * the database does. The table is created inside a transaction that is
 * always rolled back, so a success here changes nothing — but it does mean
 * the promise was never real.
 */
export async function proveCannotWrite(
  client: Client,
): Promise<{ blocked: true; error: string } | { blocked: false }> {
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE ledar_write_probe (x int)');
    await client.query('ROLLBACK');
    return { blocked: false };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The failed statement already aborted the transaction. Nothing to undo.
    }
    return { blocked: true, error: err instanceof Error ? err.message : String(err) };
  }
}

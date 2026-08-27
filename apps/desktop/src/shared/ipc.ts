/**
 * The whole vocabulary between the renderer and the main process.
 *
 * Everything the window can ask for is on this page. That is the point of
 * keeping it in one file: the preload bridge is the security boundary of the
 * shell (AGENTS.md hard rule 7 — being on the same machine is not
 * authentication, and being in the same app is not either), and a boundary
 * whose surface cannot be read in one sitting is a boundary nobody audits.
 *
 * Types only, plus channel names. No imports, no runtime dependencies —
 * both compilation targets (node and browser) include this file and neither
 * should drag the other's world in through it.
 */

export const CHANNELS = {
  /** The SQL shown before any connection exists: create-role and undo. */
  guide: 'ledar:guide',
  /** Connect, interrogate the database about itself, hand back the verdict. */
  connect: 'ledar:connect',
  /** Copy text via the OS clipboard. Lives in main so the renderer needs no permission. */
  copyText: 'ledar:copy-text',
  /** Dev-only: prefilled DSN for the smoke run. Null in a packaged build. */
  devPrefill: 'ledar:dev-prefill',
  /** Dev-only: one line the smoke run prints to stdout as its evidence. */
  devReport: 'ledar:dev-report',
} as const;

/** What the database said about this session — every field measured, none assumed. */
export type SessionFacts = {
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

/** The write that was attempted so the promise would not have to be believed. */
export type WriteProbeFacts =
  | { blocked: true; error: string }
  | { blocked: false };

export type WritableTableFacts = {
  schema: string;
  table: string;
  privileges: string[];
};

/**
 * What was looked at, said by the backend in whole sentences.
 *
 * `lines` come from `describeScope` — numerator and denominator composed on
 * the backend, per reconciliation law 1 (the FE never divides) and law 2
 * (a negative claim carries its scope).
 */
export type ScopeFacts = {
  lines: string[];
  tablesReadable: number;
  tablesInRequestedSchemas: number;
  tablesInDatabase: number;
  /** The exact SQL that takes this access away again. */
  revokeSql: string;
};

export type ConnectOutcome =
  /** The connection never opened. The message is pg's, shown locally, never logged. */
  | { kind: 'connect_error'; message: string }
  /** Superuser or BYPASSRLS. No scan, no override — only the SQL for a proper role. */
  | {
      kind: 'refused';
      reason: string;
      session: SessionFacts;
      probe: WriteProbeFacts;
      roleSql: string;
    }
  /** The role can still write somewhere. Shown plainly, with the repair SQL. */
  | {
      kind: 'writable';
      session: SessionFacts;
      probe: WriteProbeFacts;
      disclosure: string;
      writable: WritableTableFacts[];
      repairSql: string;
      scope: ScopeFacts;
    }
  /** The database itself prevents writes. The sentence S2 exists to earn. */
  | {
      kind: 'read_only_enforced';
      session: SessionFacts;
      probe: WriteProbeFacts;
      scope: ScopeFacts;
    };

/** The create-role and undo SQL shown in the guide, before any connection exists. */
export type GuideBundle = {
  roleSql: string;
  revokeSql: string;
  /** The role name both scripts are written around, so copy matches copy. */
  roleName: string;
};

export type DevPrefill = { dsn: string; autoconnect: boolean; exitWhenProven: boolean } | null;

/** The API `window.ledar` exposes. The preload bridge implements exactly this. */
export type LedarBridge = {
  guide(): Promise<GuideBundle>;
  connect(dsn: string): Promise<ConnectOutcome>;
  copyText(text: string): Promise<boolean>;
  devPrefill(): Promise<DevPrefill>;
  devReport(line: string): void;
};

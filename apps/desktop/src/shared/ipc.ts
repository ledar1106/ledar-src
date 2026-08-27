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
  /** Look at the connected database and record the run. Takes a session handle. */
  scan: 'ledar:scan',
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
      /**
       * The one outcome that opens a session, and deliberately the only one.
       *
       * A handle is issued because the database refused a write in front of
       * us. `writable` and `refused` get none: holding a credential open for
       * a connection this product has just declined to vouch for would be
       * keeping the key to a door it said not to walk through.
       */
      handle: SessionHandle;
    };

/** The create-role and undo SQL shown in the guide, before any connection exists. */
export type GuideBundle = {
  roleSql: string;
  revokeSql: string;
  /** The role name both scripts are written around, so copy matches copy. */
  roleName: string;
};

/**
 * The handle the renderer holds instead of a connection string.
 *
 * Opaque on purpose, and this is the shape Sol named `OperationSession`
 * (audit 2026-08-27, blockers 2 and 3). The DSN stays in the main process for
 * the life of the window; the renderer is handed a string it cannot do
 * anything with except name the session it already proved.
 *
 * ⚠️ This is the CREDENTIAL half only. The other two halves Sol specified —
 * a catalog epoch bound into anything sealed, and an egress authority over
 * what may leave the machine — are NOT here, because nothing in this slice
 * seals a rule or calls a model. Building them now would be guessing at a
 * design that is still open.
 */
export type SessionHandle = string;

/** One rendered finding. Every sentence in it was written by the backend. */
export type ReportFinding = {
  /** Consequence first, in the product's own words. Rendered verbatim. */
  plainText: string;
  /** The same thing for whoever has to fix it. Collapsed behind a toggle. */
  technical: string;
  /**
   * Which section of the report this belongs under.
   *
   * `confirms` is what the database itself vouches for; `patterns` is what
   * the product noticed and has NOT confirmed. They are separate because
   * `_doc/25` 3.3 makes provenance decide appearance, and a pattern styled as
   * a fact is the product claiming something it has not earned.
   */
  section: 'confirms' | 'patterns';
  /** "but only this far" — present on negatives and abstentions, never cut. */
  boundary: string | null;
};

/**
 * The verdict, straight from `reportVerdict` in contracts.
 *
 * Four kinds, and `_doc/25` is explicit that no two may look alike. In
 * particular `nothing_seen` — an empty database — must carry no success
 * styling at all: not a tick, not a green, nothing. That is the shape a real
 * reader misread in VS-7, and the demo shipped it wrong once already.
 */
export type ReportVerdict = {
  kind: 'nothing_seen' | 'silence_with_gaps' | 'silence_is_clean' | 'raised';
  headline: string;
  gaps: string[];
  meaning: string[];
};

export type ScanOutcome =
  /** The session is gone, or was never proved. Nothing ran. */
  | { kind: 'no_session'; message: string }
  /** The scan started and could not finish. Says how far it got. */
  | { kind: 'scan_error'; message: string; historyLines: string[] }
  | {
      kind: 'scanned';
      /**
       * The scope strip. Printed at the TOP and the BOTTOM of the report and
       * never hidden — it is the D in the product's name, not a footnote.
       */
      scopeStrip: string;
      /** The fuller scope sentences, as `describeScope` wrote them. */
      scopeLines: string[];
      verdict: ReportVerdict;
      findings: ReportFinding[];
      /** What the scan cost the database, composed by the backend. */
      costLine: string;
      /** Where the run was recorded, or why it was not. Always said. */
      historyLines: string[];
      /** The SQL that takes this access away again. */
      revokeSql: string;
    };

export type DevPrefill = { dsn: string; autoconnect: boolean; exitWhenProven: boolean } | null;

/** The API `window.ledar` exposes. The preload bridge implements exactly this. */
export type LedarBridge = {
  guide(): Promise<GuideBundle>;
  connect(dsn: string): Promise<ConnectOutcome>;
  scan(session: SessionHandle): Promise<ScanOutcome>;
  copyText(text: string): Promise<boolean>;
  devPrefill(): Promise<DevPrefill>;
  devReport(line: string): void;
};

/**
 * Shapes the store needs that the shared contracts do not have yet.
 *
 * Every type in this file is a candidate for `@ledar/contracts`. They live
 * here because the store needed them before the contract package had them,
 * and inventing a second source of truth on purpose is better than editing a
 * package another slice is holding open.
 *
 * `ScanCost` in particular is deliberately structural rather than an import
 * of `BudgetSpend` from `@ledar/connector-postgres`: taking that import would
 * drag the `pg` driver into a package whose whole job is to write a local
 * file. A scan history should be readable on a machine that cannot reach the
 * database it describes.
 */

import type { Coverage, Finding, Lang, ScopeManifest } from '@ledar/contracts';

/**
 * What a scan cost the database it was pointed at.
 *
 * Structurally identical to `BudgetSpend`. Kept as its own type so this
 * package has no opinion about which connector produced it — the second
 * connector will produce the same three numbers or it will be lying about
 * something.
 */
export type ScanCost = {
  queries: number;
  totalMs: number;
  rowsScanned: number;
};

/**
 * Which database a run belongs to, without holding anything that unlocks it.
 *
 * The name alone is not an identity: half the Postgres instances in the world
 * have a database called `postgres`, and treating two of them as one would
 * silently merge two histories into a diff full of phantom changes. Host and
 * port are what separate them.
 *
 * None of these three fields is stored in the clear. They are hashed into a
 * fingerprint (see `databaseFingerprint`). A hostname is not customer data,
 * but it is the kind of thing that turns a `.db` attached to a bug report
 * into an inventory of somebody's infrastructure.
 */
export type DatabaseIdentity = {
  /** Hostname or socket path as the user typed it. Never a full DSN. */
  host: string;
  port: number;
  /** The database name, as `current_database()` reports it. */
  database: string;
};

/**
 * How a run ended.
 *
 * `running` is not a success state and not a failure state — it is what a run
 * looks like when the process died before it could say. A diff that treats
 * one of these as a baseline will report every finding in it as "fixed",
 * which is the exact failure this whole package exists to avoid.
 */
export type RunOutcome = 'running' | 'completed' | 'failed' | 'refused';

export type OpenRunInput = {
  database: DatabaseIdentity;
  /**
   * Which language this run's prose was rendered in. Debt N44.
   *
   * Optional, defaulting to English, because nothing reads it to decide
   * anything — identity and the diff never touch prose, so a history holding
   * both languages compares correctly without it. What it buys is the ability
   * to EXPLAIN such a history: two runs against one database that read
   * completely differently, with nothing on the page saying why, is the kind
   * of gap this project files as a defect before it becomes one.
   */
  lang?: Lang;
  /** What the user calls this database. Defaults to `database.database`. */
  label?: string;
  /** ISO-8601. Defaults to now. */
  startedAt?: string;
  scope: ScopeManifest;
  /**
   * Whether to keep the redacted sample rows attached to evidence.
   *
   * Off by default, and the choice is written onto the run, so a later reader
   * can tell "no samples were produced" from "samples were not kept". Even
   * with this on, the store refuses sample values that are not in redacted
   * form — see `assertSampleIsRedacted`.
   */
  storeSamples?: boolean;
};

export type FinishRunInput = {
  /** ISO-8601. Defaults to now. */
  finishedAt?: string;
  outcome: Exclude<RunOutcome, 'running'>;
  /** Why it failed or was refused. Required for anything but `completed`. */
  note?: string | null;
  cost: ScanCost;
  /**
   * The sentence the budget produces when it cut something short.
   *
   * Null means nothing was cut. It is stored rather than recomputed because a
   * run read back six months later has no budget object left to ask.
   */
  truncationNote?: string | null;
};

/**
 * Proof that a rule actually executed, kept apart from what it found.
 *
 * Without this a disappeared finding is unreadable: the rule may have been
 * fixed, or the rule may not have run. Those are opposite answers and the
 * finding table cannot tell them apart, because a rule that did not run
 * leaves exactly the same trace as a rule that found nothing.
 */
export type RuleRun = {
  rule: string;
  /** False when a limit, an error, or a missing privilege stopped it. */
  ran: boolean;
  coverage?: Coverage;
  note?: string | null;

  /**
   * Which release of the rule ran. Debt N40.
   *
   * `engineRuleVersion` on a `Finding` already covers a rule that found
   * something. This covers the case that has no finding to carry it — a rule
   * that ran and raised nothing — which is the older side of every `appeared`
   * verdict a diff ever draws. Upgrading a rule produces exactly the picture
   * of *the old one saw nothing, the new one sees something*, so at the moment
   * the question "your data or your tool?" is worth most, the diff could only
   * answer that it did not know.
   *
   * Optional, and absent means absent. A version inferred from another rule in
   * the same package is a fabricated measurement, and the diff's
   * `rule-version-unknown` is a true answer where a guess would be a false one.
   */
  ruleVersion?: string;
};

export type RunSummary = {
  runId: number;
  /**
   * The language the run was rendered in, or null for a history written before
   * schema 4 recorded it.
   *
   * Null is not 'en'. A run from schema 3 was almost certainly English — there
   * was no other option — but "almost certainly" is a guess, and a guess in a
   * record is indistinguishable from a measurement once it is written down.
   */
  lang: Lang | null;
  databaseId: number;
  fingerprint: string;
  label: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: RunOutcome;
  outcomeNote: string | null;
  scope: ScopeManifest;
  cost: ScanCost;
  /** True when the budget stopped at least one check. */
  costTruncated: boolean;
  truncationNote: string | null;
  samplesStored: boolean;
  findingCount: number;
};

/**
 * A finding as it comes back out of the store.
 *
 * `findingKey` and `structureHash` are the two columns a diff joins on and
 * compares. Everything else is what gets shown once the diff has decided the
 * finding is worth showing.
 */
export type StoredFinding = {
  runId: number;
  findingKey: string;
  structureHash: string;
  finding: Finding;
};

/**
 * One appearance of one finding, for reading a single finding over time.
 *
 * The provenance fields are here rather than only in `findingsOf` because
 * this is the row a diff is built out of, and a diff that can see only the
 * structure hash has to attribute every change to the customer's database.
 * `engineRuleVersion` in particular is the column that separates *we rewrote
 * the rule* from *your data moved*; see `structureHash` for why it is beside
 * the hash and not inside it.
 */
export type FindingHistoryEntry = {
  runId: number;
  startedAt: string;
  outcome: RunOutcome;
  findingKey: string;
  structureHash: string;
  severity: string;
  confidence: string;
  /** `evidence.rowCount`, or null when the finding carried no evidence. */
  measuredRows: number | null;

  /** Where the claim came from — `catalog`, `counted`, `name_pattern`, … */
  origin: string;
  /** What its confidence rests on. Half of the same sentence as `origin`. */
  confidenceBasis: string;
  /** How far it may travel. */
  egressClass: string;
  /** When this claim was measured, not when the run started. */
  observedAt: string;
  /** Which version of the rule produced it. Read this beside the hash. */
  engineRuleVersion: string;
  /** Whether the system's owner has ruled on it. */
  userStatus: string;
};

/**
 * A finding as one run recorded it, from a history file of any schema version.
 *
 * This is `FindingHistoryEntry` with one difference that is the whole reason
 * the type exists: `engineRuleVersion` is nullable here. Schema 1 predates
 * provenance — the column is not empty in those files, it is *absent* — and a
 * reader that filled it with `''` or `'unknown'` on the way out would hand the
 * diff a version string it could compare, when the honest answer is that
 * there is nothing to compare. Null is the only value that survives being
 * read carelessly, because it cannot be equal to anything.
 *
 * `rule` is carried rather than parsed back out of `findingKey`. The key
 * begins with something that looks like the rule name, and the day that stops
 * being true a diff built on parsing it would match the wrong coverage row
 * and call a finding "still there" or "gone" on the strength of a prefix.
 */
export type RecordedFinding = {
  runId: number;
  findingKey: string;
  /** What the claim is *about*. Moves when the structure moves. */
  structureHash: string;
  rule: string;
  kind: string;
  severity: string;
  confidence: string;
  /** `evidence.rowCount`, or null when the finding carried no evidence. */
  measuredRows: number | null;
  /** Null when the file holding this row predates provenance — see above. */
  engineRuleVersion: string | null;
};

/**
 * Which file a snapshot came out of, and what that file can say.
 *
 * `recordsEngineVersion` is derivable from `schemaVersion`, and it is here
 * anyway. A diff has to ask "can this side tell me which rule version ran"
 * at several points, and a comparison spelled `schemaVersion >= 2` at each of
 * them is a comparison that will still be there, still reading 2, after the
 * next bump moves the answer. The reader that opened the file is the only
 * thing that knows; it says so once.
 */
export type SnapshotSource = {
  /** The history file itself, as the reader was given it. */
  path: string;
  schemaVersion: number;
  /** False for schema 1: every `engineRuleVersion` in it is null. */
  recordsEngineVersion: boolean;
  /**
   * Whether `structureHash` from this file means the same thing as one from
   * the current build. False for schema 1, and this is measured, not feared.
   *
   * `structureHash` hashes `origin` and `confidenceBasis` among other fields.
   * Schema 1 predates both columns, so the hashes in those files were built
   * from a shorter list — a different recipe, not a different structure. The
   * two negative claims on the empty database this was measured against come
   * out `1aab6107…` and `0086f727…` in `history.v1.db`, and `480464ae…` and
   * `3a0fa116…` in every file after it. Nothing about that database changed
   * between those runs; nothing about it *could* change, it holds no rows.
   *
   * A diff that compares the hashes anyway reports every carried-over finding
   * as "the structure changed" — not occasionally, but for all of them, on a
   * database nobody touched. That is the precise false alarm the whole slice
   * exists to prevent, so the flag is beside the hash rather than something a
   * reader is expected to remember.
   */
  comparableStructureHash: boolean;
};

/**
 * Everything one run recorded, gathered from whichever file holds it.
 *
 * The point of this shape is that a live store and a retired file produce the
 * same one. A diff should not know, and cannot ask, whether the older side of
 * the comparison came from the history this build writes to or from a file it
 * refuses to write to — only what that file was able to record, which is what
 * `source` says.
 *
 * `rules` is not decoration beside `findings`. A finding that is in `before`
 * and not in `after` is unreadable without it: the rule may have run and
 * found nothing, or may not have run at all, and the finding table leaves the
 * same empty space either way.
 */
export type RunSnapshot = {
  source: SnapshotSource;
  run: RunSummary;
  findings: RecordedFinding[];
  rules: RuleRun[];
};

/**
 * How one call to a model ended — HS-D D.4.
 *
 * A copy of `LlmCallOutcome` in `@ledar/contracts`, held here for the same
 * reason every other vocabulary in this package is: the store has no runtime
 * dependency on contracts, and `vocabulary.test.ts` compares the two at test
 * time. A copy nobody compares is how two sources of truth drift.
 */
export type LlmCallOutcome = 'ok' | 'failed' | 'refused';

/**
 * One call to a model, on the way in.
 *
 * Every count is optional and every optional one means *there is nothing to
 * count*, never *zero*. `recordLlmCall` writes `null` for an absent value and
 * never `0`, and the DDL refuses the combinations that would let the two read
 * alike.
 */
export type LlmCallInput = {
  /** Null for a call that belonged to no scan — onboarding asks first. */
  runId: number | null;
  /** ISO-8601. Defaults to now. */
  at?: string;
  /** The tier that was asked for. Free text; the tier list belongs to D.1. */
  tier: string;
  /** What actually answered, as the provider named it. */
  model: string;
  outcome: LlmCallOutcome;
  /** True when nothing was contacted. */
  cacheHit: boolean;
  promptTokens?: number | null;
  completionTokens?: number | null;
  /** Millionths of a unit of currency, so no float rounds anybody's bill. */
  costMicros?: number | null;
  /** Which price list produced `costMicros`. Required whenever it is present. */
  priceBasis?: string | null;
  /** Why it failed or was refused. Required unless the outcome is `ok`. */
  note?: string | null;
};

/** One call as the history holds it. */
export type LlmCallRow = {
  id: number;
  runId: number | null;
  at: string;
  tier: string;
  model: string;
  outcome: LlmCallOutcome;
  cacheHit: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  costMicros: number | null;
  priceBasis: string | null;
  note: string | null;
};

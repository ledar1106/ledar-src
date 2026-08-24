/**
 * The tables, and the invariants pushed down into them.
 *
 * Every CHECK here replaces a rule someone would otherwise have to remember.
 * That is the whole reason they are in the DDL rather than in a validate()
 * function: a validate() can be skipped, and the second writer of this store
 * — the diff slice, an import tool, a repair script someone runs at 2am —
 * will not know it existed.
 *
 * All tables are STRICT. Without it SQLite will happily put the string
 * "unknown" in an INTEGER column, and a scope denominator that reads as text
 * on the way out is the two-denominator bug wearing a different hat.
 */

import type { DatabaseSync } from 'node:sqlite';

/**
 * Bumped whenever the shape below changes.
 *
 * There is no migration machinery, on purpose. A store this young does not
 * have data worth migrating, and a half-written migrator that silently
 * mis-migrates a history is worse than a refusal to open the file. When there
 * is real history to keep, this is where the upgrade path goes.
 *
 * 1 → 2, when every claim gained its own provenance (`_doc/05` §7). Six
 * columns on `finding`, all NOT NULL, and that is what forces the bump: a
 * version-1 file opened by this build would pass the version check, then fail
 * on the first INSERT with "table finding has no column named origin" — an
 * error about SQLite for what is really an unmigrated file, arriving after the
 * scan has already run. Refusing at open is the same refusal, said early and
 * in a sentence the person can act on.
 *
 * The cost is stated rather than softened: every `.db` written before this
 * build stops opening. It is paid now because no history file exists outside
 * this repository's tests yet, and the same six columns added a month from now
 * would cost somebody their scan history instead.
 *
 * 2 → 3, when the closed vocabularies became CHECK constraints (debt N29).
 * SQLite cannot add a CHECK to an existing table without rebuilding it, so the
 * shape changed and the version had to follow.
 *
 * ⚠️ The argument used for 1 → 2 — "no history file exists outside this
 * repository's tests yet" — was FALSE when it was written, and finding that
 * out cost the default history path several weeks of silence (N28). It is not
 * being reused. This bump is justified differently: `openHistory` now moves an
 * unreadable file aside, byte for byte, under a name that says what it is, and
 * says so on screen. The cost is no longer "somebody loses their history"; it
 * is "somebody's history stops being compared against, loudly, and the file is
 * still there". That is a cost worth paying for a fence; the previous one was
 * not, and was paid anyway.
 */
export const SCHEMA_VERSION = 4;

/**
 * The closed vocabularies, copied here on purpose — and tripwired.
 *
 * Debt N29. Six provenance columns and three older ones were TEXT with no
 * value list, and the DDL said why: the list lives in `@ledar/contracts`, and
 * a copy here is a second source of truth that goes stale silently. That
 * reasoning was right about the risk and wrong about the conclusion, because
 * this codebase already knows what to do with a copy that has a good reason to
 * exist — lesson 14, learned from three redactors that agreed on everything
 * except the branch nobody ran: **a copy with a good reason needs a TRIPWIRE,
 * not a promise in a comment.**
 *
 * `packages/store/test/vocabulary.test.ts` compares every list below against
 * the enum it mirrors and fails on any difference in either direction. So the
 * copy cannot drift, and the fence exists where it is worth having.
 *
 * Why the fence belongs in the DDL rather than in a validate() on the way out
 * — the reason stated at the top of this file, applied to itself: a validate()
 * can be skipped, and the second writer of this store (the diff slice, an
 * import tool, a repair script somebody runs at 2am) will not know it existed.
 * A CHECK is enforced against every writer SQLite has, including a person with
 * the sqlite3 CLI and a hand-edit, which is exactly the case N29 names.
 *
 * The store still has no RUNTIME dependency on contracts. Nothing here imports
 * anything; the test does the comparing, at test time.
 */
const KINDS = "'observation', 'inference', 'recommendation', 'negative', 'abstained'";
const CONFIDENCES = "'certain', 'probable', 'unconfirmed'";
const SEVERITIES = "'info', 'low', 'medium', 'high', 'critical'";
const ORIGINS =
  "'catalog', 'counted', 'sampled', 'name_pattern', 'user_declared', " +
  "'user_confirmed', 'model_written'";
const BASES =
  "'database_constraint', 'full_count', 'sample_extrapolation', " +
  "'name_similarity', 'user_statement', 'model_output'";
// Guessed wrong on the first attempt — 'customer-data' and 'ledar-internal'
// are not words this system uses. The tripwire below caught it on its first
// run, which is the argument for having one written by the failure itself.
const EGRESS_CLASSES =
  "'never-leaves', 'customer-system-metadata', 'product-constant'";
const USER_STATUSES = "'unreviewed', 'confirmed', 'rejected', 'intentional'";
/**
 * The languages a run can be rendered in. Debt N44.
 *
 * A copy of `LANGS` from contracts, here for the same reason every other list
 * on this page is: the DDL cannot import TypeScript, so it holds its own copy
 * and `STORE_VOCABULARY` exposes it to the tripwire test that compares the two.
 * A copy nobody compares is how two sources of truth drift; a copy something
 * compares is a fence.
 */
const LANGS_SQL = "'en', 'vi'";

/** Every list above, keyed the way the tripwire test reads them. */
export const STORE_VOCABULARY: Readonly<Record<string, readonly string[]>> = {
  kind: KINDS.split(',').map((v) => v.trim().replace(/'/g, '')),
  confidence: CONFIDENCES.split(',').map((v) => v.trim().replace(/'/g, '')),
  severity: SEVERITIES.split(',').map((v) => v.trim().replace(/'/g, '')),
  origin: ORIGINS.split(',').map((v) => v.trim().replace(/'/g, '')),
  confidenceBasis: BASES.split(',').map((v) => v.trim().replace(/'/g, '')),
  egressClass: EGRESS_CLASSES.split(',').map((v) => v.trim().replace(/'/g, '')),
  userStatus: USER_STATUSES.split(',').map((v) => v.trim().replace(/'/g, '')),
  lang: LANGS_SQL.split(',').map((v) => v.trim().replace(/'/g, '')),
};

const DDL: readonly string[] = [
  `
  CREATE TABLE store_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT
  `,

  /**
   * Which database a history belongs to.
   *
   * The fingerprint is a hash of host + port + name, so this table can say
   * "these runs are about the same database" without holding the address of
   * anybody's server. `label` is whatever the user calls it and is the only
   * thing here meant to be read by a human.
   */
  `
  CREATE TABLE scanned_database (
    id            INTEGER PRIMARY KEY,
    fingerprint   TEXT NOT NULL UNIQUE,
    label         TEXT NOT NULL,
    first_seen_at TEXT NOT NULL
  ) STRICT
  `,

  /**
   * One scan.
   *
   * The scope columns are the manifest, stored field by field rather than as
   * a JSON blob, so that `scope_total_tables IS NULL` is a queryable fact
   * instead of something a reader has to parse and interpret. That column is
   * the whole reason this table is not three columns wide: null means nobody
   * told us how many tables exist, and it must never arrive here as a 0.
   *
   * `outcome = 'running'` is a run that never reported back. It is kept
   * rather than deleted because a crashed scan is evidence too, and paired
   * with the CHECK below it can never be mistaken for a finished one.
   */
  `
  CREATE TABLE run (
    id           INTEGER PRIMARY KEY,
    database_id  INTEGER NOT NULL REFERENCES scanned_database(id) ON DELETE CASCADE,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    outcome      TEXT NOT NULL
      CHECK (outcome IN ('running', 'completed', 'failed', 'refused')),
    outcome_note TEXT,

    scope_database           TEXT NOT NULL,
    scope_role               TEXT NOT NULL,
    scope_schemas            TEXT NOT NULL,
    scope_visible_tables     INTEGER NOT NULL CHECK (scope_visible_tables >= 0),
    scope_total_tables       INTEGER
      CHECK (scope_total_tables IS NULL OR scope_total_tables >= scope_visible_tables),
    scope_granted_at         TEXT,
    scope_read_only_enforced INTEGER NOT NULL CHECK (scope_read_only_enforced IN (0, 1)),
    scope_disclosure         TEXT,

    cost_queries      INTEGER NOT NULL DEFAULT 0 CHECK (cost_queries >= 0),
    cost_total_ms     INTEGER NOT NULL DEFAULT 0 CHECK (cost_total_ms >= 0),
    cost_rows_scanned INTEGER NOT NULL DEFAULT 0 CHECK (cost_rows_scanned >= 0),
    cost_truncated    INTEGER NOT NULL DEFAULT 0 CHECK (cost_truncated IN (0, 1)),
    truncation_note   TEXT,

    samples_stored INTEGER NOT NULL CHECK (samples_stored IN (0, 1)),

    -- Which language this run's prose was rendered in. Debt N44.
    --
    -- Nothing reads it to decide anything, and that is deliberate: identity
    -- and the diff never touch prose, so a history holding both languages
    -- compares correctly without this column. What the column buys is the
    -- ability to EXPLAIN such a history. Opening one and finding two runs
    -- against the same database that read completely differently, with
    -- nothing on the page saying why, is the kind of gap this project files
    -- as a defect even when nothing is wrong yet.
    --
    -- DEFAULT 'en' so the column is not a second thing every INSERT has to
    -- remember, and NOT NULL because "no language" is not a state a rendered
    -- report can be in.
    lang TEXT NOT NULL DEFAULT 'en' CHECK (lang IN (${LANGS_SQL})),

    CHECK ((outcome = 'running') = (finished_at IS NULL)),
    CHECK (cost_truncated = 1 OR truncation_note IS NULL)
  ) STRICT
  `,

  /**
   * What each rule was able to do, whether or not it found anything.
   *
   * A rule that ran and found nothing and a rule that never ran leave the
   * same absence in the finding table. Without this table the diff has to
   * guess which one happened, and the guess it would make is "fixed" — the
   * most reassuring of the two, and the wrong one.
   *
   * The three coverage counts are nullable and default to NULL, not 0. NULL
   * means the caller did not say. Zero means the rule looked at nothing. They
   * read the same in a report and mean opposite things, which is the same
   * mistake as a scope with one denominator.
   */
  `
  CREATE TABLE run_rule (
    run_id       INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    rule         TEXT NOT NULL,
    ran          INTEGER NOT NULL CHECK (ran IN (0, 1)),
    checked      INTEGER CHECK (checked IS NULL OR checked >= 0),
    eligible     INTEGER CHECK (eligible IS NULL OR eligible >= 0),
    skipped      INTEGER CHECK (skipped IS NULL OR skipped >= 0),
    truncated_at INTEGER,
    note         TEXT,

    -- Which release of the rule ran. Debt N40, and the most common diff case
    -- there is.
    --
    -- engine_rule_version already sits on every finding, which covers a rule
    -- that FOUND something. It says nothing about a rule that ran and raised
    -- nothing — and that is exactly the older side of every appeared
    -- verdict. Upgrading a rule produces precisely the picture of "the old one
    -- saw nothing, the new one sees something", so at the moment the question
    -- *"is this your data or your tool?"* is worth most, the diff had to
    -- answer "cannot say".
    --
    -- Nullable, and never inferred. A version guessed from another rule in the
    -- same package is a fabricated measurement, and rule-version-unknown is
    -- a true answer where a guess would be a false one.
    rule_version TEXT,

    -- The coverage split _doc/05 asks for. Debt N1.
    --
    -- All four nullable, all four meaning *this rule did not separate these*.
    -- checked and eligible above are the pair every rule has always been
    -- able to state; these pull that pair apart, and a rule with nothing
    -- honest to put here writes NULL rather than a zero that reads as a
    -- measurement.
    visible_to_role INTEGER CHECK (visible_to_role IS NULL OR visible_to_role >= 0),
    verified        INTEGER CHECK (verified IS NULL OR verified >= 0),
    sampled         INTEGER CHECK (sampled IS NULL OR sampled >= 0),
    excluded        INTEGER CHECK (excluded IS NULL OR excluded >= 0),

    -- The arithmetic, in the file rather than only in the code that writes to
    -- it. A row can arrive from a build older than the constraint, from a
    -- migration, or from somebody with sqlite3 open; the type refuses all of
    -- them equally.
    CHECK (
      verified IS NULL OR sampled IS NULL OR checked IS NULL
      OR verified + sampled = checked
    ),
    CHECK (
      visible_to_role IS NULL OR eligible IS NULL
      OR visible_to_role >= eligible
    ),
    CHECK (excluded IS NULL OR checked IS NULL OR excluded <= checked),

    PRIMARY KEY (run_id, rule)
  ) STRICT
  `,

  /**
   * The findings of one run.
   *
   * `finding_key` is the identity across runs and `structure_hash` is what
   * changed about it — the two columns the diff joins and compares. Nothing
   * else here is used to decide whether two findings are the same thing.
   *
   * The severity and confidence values are deliberately *not* constrained to
   * a list. That list lives in `@ledar/contracts` and is validated there; a
   * copy of it in the DDL would be a second source of truth that goes stale
   * without anyone noticing until a release fails to write its own findings.
   *
   * UNIQUE (run_id, finding_key) is not housekeeping. If it ever fires, two
   * findings in one run claimed the same identity, which means the identity
   * scheme is broken and every diff built on this file is wrong. Better to
   * fail on the write than to serve that quietly for a year.
   */
  `
  CREATE TABLE finding (
    id             INTEGER PRIMARY KEY,
    run_id         INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    database_id    INTEGER NOT NULL REFERENCES scanned_database(id) ON DELETE CASCADE,

    finding_key    TEXT NOT NULL,
    structure_hash TEXT NOT NULL,

    rule         TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN (${KINDS})),
    confidence   TEXT NOT NULL CHECK (confidence IN (${CONFIDENCES})),
    severity     TEXT NOT NULL CHECK (severity IN (${SEVERITIES})),
    schema_name  TEXT NOT NULL,
    table_name   TEXT NOT NULL,
    columns_json TEXT NOT NULL,

    -- ---- provenance ------------------------------------------------------
    --
    -- _doc/05 section 7 puts these on the claim rather than on the run, and a
    -- history file is the first place that distinction has teeth. A run row
    -- says what the scan was; these say what THIS sentence was, and a finding
    -- read back six months from now is read alone.
    --
    -- All six are NOT NULL. There is no honest default for any of them: a
    -- claim whose origin nobody recorded is a claim nobody can weigh, and
    -- filling one in here would be this file inventing a measurement.
    --
    -- CHECK-constrained since 2026-08-22 (debt N29). The comment that used to
    -- sit here argued against a value list because a copy of the vocabulary
    -- goes stale silently — right about the risk, wrong about what to do with
    -- it. A copy with a good reason gets a TRIPWIRE (lesson 14), and there is
    -- one: packages/store/test/vocabulary.test.ts. Without the fence, a
    -- hand-edited .db with origin = 'banana' read back as though nothing were
    -- wrong, and only sealFindings caught it — on the way OUT, long after
    -- anything reading the file directly had already believed it.
    origin              TEXT NOT NULL CHECK (origin IN (${ORIGINS})),
    confidence_basis    TEXT NOT NULL CHECK (confidence_basis IN (${BASES})),
    egress_class        TEXT NOT NULL CHECK (egress_class IN (${EGRESS_CLASSES})),

    -- Per claim, not per run. A scan of 374 tables takes long enough for the
    -- database to change underneath it, so a count taken at the start and one
    -- taken at the end are statements about two different databases.
    observed_at         TEXT NOT NULL,

    -- What lets a diff tell "the data moved" from "we rewrote the rule".
    -- Deliberately NOT folded into structure_hash: see structureHash() in
    -- identity.ts for the trade and what it costs.
    engine_rule_version TEXT NOT NULL,

    -- Today every row here says 'unreviewed', because nothing in the product
    -- asks the question yet. It is stored anyway: this is an append-only
    -- history, and "nobody had ruled on this at the time of run 4" is a fact
    -- about run 4 that becomes unrecoverable the moment reviews start
    -- existing. A column added later could only be filled with a guess.
    user_status         TEXT NOT NULL CHECK (user_status IN (${USER_STATUSES})),

    plain_text TEXT NOT NULL,
    technical  TEXT NOT NULL,
    boundary   TEXT,

    evidence_sql         TEXT,
    evidence_row_count   INTEGER,
    evidence_sample_size INTEGER,
    evidence_duration_ms REAL,
    evidence_sample_json TEXT,

    coverage_checked      INTEGER NOT NULL CHECK (coverage_checked >= 0),
    -- Nullable, for the same reason run_rule.eligible is: NULL means the
    -- rule could not work out its own denominator, 0 means there was
    -- nothing to check. Storing 0 for both is how not knowing comes to be
    -- read as a clean result. This column was NOT NULL while the contract
    -- allowed null, so a finding that admitted ignorance could not be
    -- written down at all.
    coverage_eligible     INTEGER CHECK (coverage_eligible IS NULL OR coverage_eligible >= 0),
    coverage_skipped_json TEXT NOT NULL,
    coverage_truncated_at INTEGER,

    -- Debt N1, on the claim rather than on the run. The same four, and the
    -- same rule about NULL. The most useful of them here is coverage_sampled
    -- on a Layer B finding: a column answered from a sample and a column read
    -- end to end produce the same finding shape, and without this the record
    -- could not tell a clean full read from a clean sample.
    coverage_visible_to_role INTEGER
      CHECK (coverage_visible_to_role IS NULL OR coverage_visible_to_role >= 0),
    coverage_verified INTEGER
      CHECK (coverage_verified IS NULL OR coverage_verified >= 0),
    coverage_sampled INTEGER
      CHECK (coverage_sampled IS NULL OR coverage_sampled >= 0),
    coverage_excluded INTEGER
      CHECK (coverage_excluded IS NULL OR coverage_excluded >= 0),

    CHECK (
      coverage_verified IS NULL OR coverage_sampled IS NULL
      OR coverage_verified + coverage_sampled = coverage_checked
    ),
    CHECK (
      coverage_visible_to_role IS NULL OR coverage_eligible IS NULL
      OR coverage_visible_to_role >= coverage_eligible
    ),
    CHECK (coverage_excluded IS NULL OR coverage_excluded <= coverage_checked),

    UNIQUE (run_id, finding_key),

    CHECK ((kind = 'negative') = (boundary IS NOT NULL)),
    -- The same rule sealFindings enforces, kept here too: "I found nothing"
    -- is only worth reading beside "out of how many". A negative claim with
    -- no denominator must not survive a round trip through this file, whoever
    -- wrote it.
    CHECK (kind != 'negative' OR coverage_eligible IS NOT NULL),
    CHECK ((evidence_sql IS NULL) = (evidence_row_count IS NULL))
  ) STRICT
  `,

  `
  CREATE INDEX run_by_database ON run (database_id, started_at DESC)
  `,

  /** The read path of a diff: one finding, every run it appeared in. */
  `
  CREATE INDEX finding_history ON finding (database_id, finding_key, run_id)
  `,
];

/**
 * Whether this file is empty, or already ours.
 *
 * Debt N37. `readSchemaVersion` answers `null` for two situations that are
 * nothing alike — a brand new file, and somebody else's SQLite database — and
 * `applySchema` treated both as "go ahead and create". So a mistyped
 * `LEDAR_HISTORY_DB` pointed at any other `.db` on the machine would grow four
 * LEDAR tables inside it, unasked and unannounced.
 *
 * Nothing had been bitten: the default path points at a directory of its own.
 * But "nothing has gone wrong yet" is the argument that had already failed
 * once today — it is what justified bumping SCHEMA_VERSION without a migration
 * path, on a machine that turned out to be holding eleven real runs.
 *
 * The test is the one thing a foreign database cannot accidentally satisfy:
 * an empty schema. A file with tables in it and no `store_meta` is somebody
 * else's, and this refuses it by name rather than adopting it.
 */
function isEmptyOrOurs(db: DatabaseSync): boolean {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all();
  return rows.length === 0;
}

export function readSchemaVersion(db: DatabaseSync): number | null {
  const table = db
    .prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'store_meta'`,
    )
    .get();
  if (table === undefined) return null;

  const row = db
    .prepare(`SELECT value FROM store_meta WHERE key = 'schema_version'`)
    .get();
  if (row === undefined) return null;

  const parsed = Number(row['value']);
  return Number.isInteger(parsed) ? parsed : null;
}

function wrongVersion(found: number): Error {
  return new Error(
    `This history file was written by schema version ${found}; this build ` +
      `speaks version ${SCHEMA_VERSION}. There is no migration path yet, and ` +
      `guessing at one would corrupt the history rather than lose it. Keep ` +
      `the file and start a new one alongside it.`,
  );
}

function notOurFile(): Error {
  return new Error(
    `This file is already a SQLite database, and it is not a LEDAR history: ` +
      `it holds tables but no store_meta table. Refusing to add LEDAR's tables ` +
      `to somebody else's database. Point LEDAR_HISTORY_DB at a new file, or ` +
      `at a path that does not exist yet.`,
  );
}

/**
 * Creates the schema, or refuses to touch a file it does not recognise.
 *
 * Refusing is the point. An older file opened by a newer build and written to
 * anyway produces a history that is half one shape and half another, and the
 * damage shows up as a diff that is subtly wrong rather than as an error.
 *
 * The version is read twice, and the second read is not paranoia. Two windows
 * of a desktop app can both open a history file that does not exist yet, and
 * they will both look, both see nothing, and both decide to create it. The
 * first read decides whether to bother; the second happens after this
 * connection holds the write lock, which is the only point from which the
 * answer cannot change underneath it. Without it the losing window gets
 * "table store_meta already exists" — an error about the schema for what is
 * really a race, and one it has no way to recover from.
 */
export function applySchema(db: DatabaseSync): void {
  const found = readSchemaVersion(db);
  if (found === SCHEMA_VERSION) return;
  if (found !== null) throw wrongVersion(found);

  // Not ours and not empty: refuse rather than move in. See `isEmptyOrOurs`.
  if (!isEmptyOrOurs(db)) throw notOurFile();

  // `BEGIN IMMEDIATE` takes the write lock now rather than at the first CREATE
  // — a deferred transaction that reads before it writes is refused instantly
  // by SQLite instead of waiting out the busy timeout, which is exactly what
  // the read below would make this.
  db.exec('BEGIN IMMEDIATE');

  let raced: number | null = null;
  try {
    raced = readSchemaVersion(db);
    if (raced === null) {
      for (const statement of DDL) db.exec(statement);
      db.prepare(`INSERT INTO store_meta (key, value) VALUES (?, ?)`).run(
        'schema_version',
        String(SCHEMA_VERSION),
      );
      db.prepare(`INSERT INTO store_meta (key, value) VALUES (?, ?)`).run(
        'created_at',
        new Date().toISOString(),
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The original failure is the one worth reporting. A rollback that
      // throws on top of it — because the transaction is already gone — would
      // otherwise replace the real error with a confusing one.
    }
    throw err;
  }

  // Thrown out here, not inside the try: the transaction is already committed
  // and a throw above would have dragged it through the rollback path.
  if (raced !== null && raced !== SCHEMA_VERSION) throw wrongVersion(raced);
}

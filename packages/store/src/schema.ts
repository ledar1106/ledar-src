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
 *
 * 3 → 4, four debts at once — N40 (`rule_version` on `run_rule`), N1 (four
 * nullable coverage columns), N42, N44 (`lang` on `run`). One bump rather than
 * four, because the cost of a bump is per-bump and not per-column.
 *
 * ⚠️ That entry is written here on 2026-08-24, after the fact. The bump landed
 * on 2026-08-23 and nobody added a paragraph, so this list read 1 → 2 → 3 for
 * a file already at 4. A version history that skips a version is worse than no
 * version history: it invites the next reader to conclude the missing bump was
 * not a real one.
 *
 * 4 → 5, `llm_call` — HS-D D.4. A new table rather than new columns, so no
 * existing row changes shape, and a schema-4 file is still perfectly readable
 * by `RetiredHistoryReader` (its `REQUIRED` list does not mention this table).
 * The bump is still owed: this store refuses any version it does not speak,
 * deliberately and with no migrator (debt N4), and *"it would probably work"*
 * is not the standard that refusal was built to hold.
 *
 * Paid now rather than when the first call happens, and that IS the feature —
 * D.4's acceptance criterion is *measure from day one*. A cost table added
 * after the bills start arriving can only describe spending from the day
 * somebody noticed, and the interesting spending is always earlier.
 *
 * 5 → 6, `finding.boundary` became NOT NULL — debt N50. Schema 5 held a CHECK
 * saying a boundary was present if and only if the kind was `negative`, which
 * forbade an abstention the sentence the contract makes its entire content;
 * the write path dropped it silently and the read path threw on the way back.
 * SQLite cannot loosen a CHECK in place, so the shape changed and the version
 * had to follow.
 *
 * ⚠️ This paragraph is written on 2026-08-28, after the fact — the bump landed
 * on 2026-08-27 and nobody added one, so this list read 1 → 2 → 3 → 4 → 5 for
 * a file already at 6. That is the SECOND time this list has been caught a
 * version behind, and the warning against it is four paragraphs up, written
 * the first time. A rule that has been broken twice is not being enforced by
 * the paragraph that states it.
 *
 * 6 → 7, `project_profile` and `project_profile_area` — ideal §23. New tables
 * rather than new columns, so nothing already written changes shape and a
 * schema-6 file is still readable by `RetiredHistoryReader` (its `REQUIRED`
 * list does not mention either table). The bump is owed for the same reason
 * 4 → 5 owed one: this store refuses every version it does not speak, and
 * *"it would probably work"* is not what that refusal was built to hold.
 *
 * The cost of this bump is the cheapest it will ever be, and that is an
 * argument about TIMING rather than the discredited one about nobody having a
 * history file. What it costs is one retirement per machine: `openHistory`
 * moves `history.db` to `history.v6.db` byte for byte and the scan says where
 * it went. The same bump after the profile has been asked for a year would
 * cost people the answers they gave.
 */
/**
 * 7 → 8, `entity_map` and `entity_edge` — ideal §31. Two new tables again, so
 * a schema-7 file keeps its shape and `RetiredHistoryReader` still reads it
 * (`REQUIRED` mentions neither).
 *
 * This one buys something the profile bump did not. The map is derived wholly
 * from a scan and costs no query to rebuild, so storing it is not about saving
 * work — it is about being able to answer *"what touches this customer"*
 * WITHOUT opening somebody's database at all. That is the difference between
 * a product that remembers a system and one that re-learns it every morning,
 * and ideal §45 is the sentence for it.
 */
/**
 * 8 → 9, `project_profile_area.stated_picked_json` — ideal §24.
 *
 * A column rather than a table, and the second bump in one day. The rule this
 * store lives under is that it refuses every version it does not speak, and
 * *"it would probably work"* is exactly what that refusal was built to hold —
 * so an added column is a bump like any other, even one added an hour after
 * the last.
 *
 * What it holds: the list a person picked when they answered yes. It survived
 * only while nothing had been seen, because `a_sighting_names_what_was_seen`
 * forbade `picked_json` on those rungs and there was nowhere else to put it.
 * The moment a scan found anything, "Supabase and Stripe" became "yes".
 */
export const SCHEMA_VERSION = 9;

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
 * The languages a run may have been rendered in. Debt N44.
 *
 * A copy of `LANGS` from contracts, here for the same reason every other list
 * on this page is: the DDL cannot import TypeScript, so it holds its own copy
 * and `STORE_VOCABULARY` exposes it to the tripwire test that compares the two.
 * A copy nobody compares is how two sources of truth drift; a copy something
 * compares is a fence.
 *
 * 🟥 **This one is deliberately WIDER than `LANGS`, and 2026-08-27 is when it
 * became so.** The product dropped Vietnamese; `LANGS` is `['en']` now. This
 * list keeps `vi`, and narrowing it would be the file lying about its own past:
 * a run recorded in Vietnamese HAPPENED in Vietnamese, and a history that
 * cannot admit the language its own rows carry is not a record.
 *
 * The relation between the two lists is therefore a SUPERSET, not equality —
 * see `vocabulary.test.ts`. Equality was right for as long as every vocabulary
 * only ever grew, and it stopped being right the first time one shrank. What
 * the store may HOLD and what the product currently RENDERS are two questions,
 * and they were the same question only by luck.
 */
const LANGS_SQL = "'en', 'vi'";

/**
 * How one call to a model ended. HS-D D.4, a copy of `LlmCallOutcome`.
 *
 * `refused` is in here because a run with no calls is otherwise ambiguous —
 * nothing needed asking, or everything was declined at the boundary — and a
 * product that promises to say what it did not do cannot store those two the
 * same way.
 */
const LLM_OUTCOMES_SQL = "'ok', 'failed', 'refused'";

/**
 * The five things the product asks about. Ideal §14–§18, a copy of
 * `ProfileArea`.
 *
 * A CHECK rather than free text, and the reason is what an area NAME is for.
 * Every screen, every plan and every conflict is keyed by one of these five
 * strings, so a sixth arriving from a hand-edit or an older build does not
 * read as a bad value — it reads as an area nobody renders, silently absent
 * from the map while sitting in the file.
 */
const PROFILE_AREAS_SQL = "'auth', 'database', 'payment', 'storage', 'jobs'";

/**
 * The rungs of the knowledge ladder. Ideal §22, a copy of `KnowledgeState`.
 *
 * 🟥 The list is closed here because the CONSTRAINTS below are written per
 * rung. A state outside this list would fall through every one of them — each
 * is phrased `state <> 'x' OR (...)` — and land in the file carrying whatever
 * combination of columns the writer felt like. The value list is what makes
 * the four constraints add up to a total rule rather than four partial ones.
 */
const KNOWLEDGE_STATES_SQL =
  "'unknown', 'stated', 'suspected', 'observed', 'verified'";

/**
 * The three answers a person may give. Ideal §13, a copy of `AreaAnswer`.
 *
 * `dont_know` is a real answer and is stored as one. It is the DEFAULT the
 * interview starts every area at, and a file that turned it into NULL would
 * lose the difference between somebody who said "I do not know" and somebody
 * who was never asked — which is the whole distinction between the `stated`
 * and `unknown` rungs.
 */
const AREA_ANSWERS_SQL = "'yes', 'no', 'dont_know'";

/**
 * The three tiers of the entity map.
 *
 * Ordered strongest first, matching `EDGE_TIERS`, because the order is what
 * `strongestFirst` sorts by and a path is only as strong as its weakest hop.
 */
const EDGE_TIERS_SQL = "'declared', 'measured', 'guessed'";

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
  llmCallOutcome: LLM_OUTCOMES_SQL.split(',').map((v) => v.trim().replace(/'/g, '')),
  profileArea: PROFILE_AREAS_SQL.split(',').map((v) => v.trim().replace(/'/g, '')),
  knowledgeState: KNOWLEDGE_STATES_SQL.split(',').map((v) => v.trim().replace(/'/g, '')),
  // One key, two columns. `answer` and `stated_answer` are constrained against
  // the same list because they hold the same vocabulary said by the same
  // person; they are separate columns because they are said at different rungs
  // and mean different things there. The tripwire watches the LIST, and there
  // is one list.
  areaAnswer: AREA_ANSWERS_SQL.split(',').map((v) => v.trim().replace(/'/g, '')),
  edgeTier: EDGE_TIERS_SQL.split(',').map((v) => v.trim().replace(/'/g, '')),
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
    -- NOT NULL as of schema 6. Debt N50: every finding states the limit of
    -- the measurement behind it, so a row without one is a row that lost
    -- something on the way in rather than one that never had it.
    boundary   TEXT NOT NULL,

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

    -- 🟥 Schema 5 held a CHECK saying boundary is present if and only if the
    -- kind is 'negative', and that was WRONG in both directions before N50
    -- was even filed. An abstention requires a boundary in the contract and
    -- this forbade it one, so the write path dropped the sentence silently
    -- and the read path threw. Nothing caught it because nothing produces an
    -- abstention yet: rule-runner does, and rule-runner has no route.
    --
    -- The column is NOT NULL now, which says the same thing for every kind
    -- and cannot be wrong about one of them.
    --
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

  /**
   * One call to a model, and what it cost. HS-D D.4.
   *
   * Written before anything can call a model, which is the acceptance
   * criterion rather than eagerness: a cost table added after the bills start
   * arriving can only describe spending from the day somebody noticed.
   *
   * ## The CHECKs are the point of this table
   *
   * Four of them, and each one refuses a row that would read as a measurement
   * without being one:
   *
   *   cost without a basis   a number derived from a price list, with nothing
   *                          saying which list. Nobody can re-derive it, and
   *                          it will be quoted years later as though measured.
   *                          Same failure as a message explaining itself with
   *                          a reason that expired (AGENTS section 4.9 point 3).
   *   refused with tokens    'refused' means nothing was sent. A token count
   *                          on such a row is a count of something that did
   *                          not happen.
   *   cache hit that failed  a cache hit contacted nobody, so there was
   *                          nothing to fail.
   *   failed/refused, no note  the whole product turns on being able to say
   *                          WHY it did not do a thing.
   *
   * ## Null is not zero, and the columns are shaped so it cannot be read as one
   *
   *   tokens NULL   nothing was sent, so there is nothing to count
   *   tokens 0      nothing was sent AND we know why — a cache hit
   *   cost   NULL   nothing was sent, or no price list covered this model
   *   cost   0      it was sent and it was free
   *
   * `run_id` is nullable because not every call happens inside a scan —
   * onboarding asks before there is anything to scan, and a cost record that
   * could only exist inside a run would quietly omit the earliest calls.
   *
   * `tier` and `model` are free text on purpose. Every other closed vocabulary
   * here is a CHECK with a tripwire, and these two are not: the tier list
   * belongs to D.1's configuration and D.1 does not exist. A fence around a
   * decision nobody has made is not a fence. Validating a tier against the
   * config is the client's job at the moment it reads the config; this table
   * records what happened, including a tier the client should have refused.
   */
  `
  CREATE TABLE llm_call (
    id      INTEGER PRIMARY KEY,
    run_id  INTEGER REFERENCES run(id) ON DELETE CASCADE,
    at      TEXT NOT NULL,

    tier    TEXT NOT NULL,
    model   TEXT NOT NULL,

    outcome TEXT NOT NULL CHECK (outcome IN (${LLM_OUTCOMES_SQL})),

    cache_hit INTEGER NOT NULL CHECK (cache_hit IN (0, 1)),

    prompt_tokens     INTEGER CHECK (prompt_tokens     IS NULL OR prompt_tokens     >= 0),
    completion_tokens INTEGER CHECK (completion_tokens IS NULL OR completion_tokens >= 0),

    cost_micros INTEGER CHECK (cost_micros IS NULL OR cost_micros >= 0),
    price_basis TEXT,

    note TEXT,

    -- A cost may be absent. A cost may not be present without the price list
    -- that produced it.
    CHECK (cost_micros IS NULL OR price_basis IS NOT NULL),

    -- 'refused' means nothing was sent, so there is nothing to have counted.
    CHECK (outcome <> 'refused' OR (prompt_tokens IS NULL AND completion_tokens IS NULL)),

    -- A cache hit contacted nobody. There was nothing to fail or to refuse.
    CHECK (cache_hit = 0 OR outcome = 'ok'),

    -- Not saying why it went wrong is the one thing this product may not do.
    CHECK (outcome = 'ok' OR (note IS NOT NULL AND note <> ''))
  ) STRICT
  `,

  /** The read path: what one run spent. */
  `
  CREATE INDEX llm_call_by_run ON llm_call (run_id, at)
  `,

  /**
   * What this product knows about one system. Ideal §23.
   *
   * This is the table that turns an interview into MEMORY. Without it the five
   * questions are asked again every session, and a product that re-asks what
   * you already told it has not remembered anything — it has a form.
   *
   * `database_id` is the PRIMARY KEY, and that single word is the whole of
   * "one profile per scanned database". Saving twice is an upsert because
   * there is nowhere for a second row to go; nothing has to remember to
   * delete first, and no read has to pick between two profiles and guess.
   *
   * Keyed off `scanned_database` rather than holding a fingerprint of its own,
   * so ON DELETE CASCADE reaches it: a history that stops holding a database
   * stops holding what it believed about that database, in one place. A second
   * fingerprint column here would be a second copy of the identity, and the
   * day the two disagree there is no way to tell which one is the profile
   * about.
   *
   * `version` and `updated_at` live on the profile rather than on the areas
   * because §24 says a profile is a thing that gets EDITED, and an edit is to
   * the map, not to one corner of it. A per-area version would let two areas
   * claim to be different versions of one document, which is not a state the
   * contract can express and not one anybody could read.
   */
  `
  CREATE TABLE project_profile (
    database_id INTEGER PRIMARY KEY REFERENCES scanned_database(id) ON DELETE CASCADE,

    -- Positive, because a profile with no version cannot be diffed and a
    -- version of 0 is what an uninitialised counter looks like.
    version    INTEGER NOT NULL CHECK (version > 0),

    -- Stored exactly as it arrived, NOT normalised through a date parser the
    -- way run.started_at is. Nothing orders by this column — there is one
    -- profile per database — so normalising would buy nothing and cost the
    -- round trip its exactness.
    updated_at TEXT NOT NULL CHECK (updated_at <> '')
  ) STRICT
  `,

  /**
   * One area of one profile, and what earns the rung it is on.
   *
   * ## Why rows and columns, and not one JSON blob
   *
   * A blob would have been less code and it would have been the wrong shape,
   * for one reason that outweighs the rest: **the contract's `AreaKnowledge`
   * is a discriminated union, and a union's whole content is which fields may
   * exist at which state.** In a blob that rule lives only in the code that
   * writes the blob — which is a validate(), and this file's header says what
   * a validate() is worth here: it can be skipped, and the second writer of
   * this store (an import tool, a repair script somebody runs at 2am, a person
   * with the sqlite3 CLI) will not know it existed.
   *
   * As columns the rule is four CHECK constraints, and SQLite enforces them
   * against every writer it has. The one the brief singles out —
   * `verified_is_seen_and_agreed` — is the reason: `verified` is the only rung
   * that means a HUMAN agreed, every later screen reads it as settled, and a
   * file able to hold a `verified` with no evidence and no `confirmedAt` is a
   * file able to manufacture that agreement. The type refuses it. So does this.
   *
   * The costs are real and are paid on purpose: five rows per profile instead
   * of one, a join on every read, and three more copied vocabularies to keep
   * tripwired. What is bought is that the FILE cannot hold what the contract
   * refuses, on a machine where the contract is not installed.
   *
   * ## What is still a blob, and the limit of that
   *
   * `evidence_json` and `picked_json` are JSON arrays in a column. The
   * constraints below reach the array — it must BE an array, and a rung that
   * requires evidence must have at least one item — and they stop there. There
   * is no CHECK that can look INSIDE the items, because iterating a JSON array
   * in SQLite needs `json_each`, and `json_each` is a table-valued function,
   * and a CHECK may not contain a subquery.
   *
   * So: an evidence item whose `where` is blank is refused by `saveProfile`
   * and NOT by this file. That is stated rather than glossed, because the
   * paragraph above claims the file enforces the union and a reader is
   * entitled to know exactly how far that claim goes.
   *
   * Normalising evidence into a third table would move the boundary, not
   * remove it — and it would move it the wrong way. Per-item CHECKs would
   * become possible and `evidence is non-empty` would become impossible, since
   * a CHECK cannot count rows in another table. Losing the invariant the brief
   * calls non-negotiable to gain one on the contents is a bad trade.
   */
  `
  CREATE TABLE project_profile_area (
    database_id INTEGER NOT NULL
      REFERENCES project_profile(database_id) ON DELETE CASCADE,

    area  TEXT NOT NULL CHECK (area  IN (${PROFILE_AREAS_SQL})),
    state TEXT NOT NULL CHECK (state IN (${KNOWLEDGE_STATES_SQL})),

    -- The 'stated' rung's own content: what the person said, with nothing
    -- measured against it.
    answer      TEXT CHECK (answer IS NULL OR answer IN (${AREA_ANSWERS_SQL})),
    picked_json TEXT
      CONSTRAINT picked_is_a_list CHECK (picked_json IS NULL OR json_type(picked_json) = 'array'),

    -- What the scan saw, in places a person could go and look at. Carried by
    -- the three rungs that claim a sighting.
    evidence_json TEXT
      CONSTRAINT evidence_is_a_list CHECK (evidence_json IS NULL OR json_type(evidence_json) = 'array'),

    -- What the person had said, kept BESIDE a sighting rather than merged into
    -- it. A separate column from \`answer\` on purpose: one column doing both
    -- jobs would mean a reader could not tell a claim from a claim-beside-a-
    -- measurement without also reading \`state\`, and these are two different
    -- kinds of knowing that the ladder's own comment forbids merging.
    --
    -- Nullable, and the null is load-bearing: it means the person was never
    -- asked about an area the scan happened to find something in.
    stated_answer TEXT
      CHECK (stated_answer IS NULL OR stated_answer IN (${AREA_ANSWERS_SQL})),

    -- What they picked, on a rung where something was also SEEN.
    --
    -- 🟥 Its own column rather than reusing \`picked_json\`, exactly as
    -- \`stated_answer\` is its own column rather than reusing \`answer\`. Each
    -- pair is the same vocabulary said at a different rung, and the four union
    -- CHECKs are phrased against which columns may be non-null — so a shared
    -- column would make 'stated' and 'observed' indistinguishable to the
    -- constraint whose whole job is telling them apart.
    stated_picked_json TEXT
      CONSTRAINT stated_picked_is_a_list
        CHECK (stated_picked_json IS NULL OR json_type(stated_picked_json) = 'array'),

    -- When they agreed, not whether. Six months on the question is never
    -- whether somebody once said yes; a system changes, and an agreement about
    -- March is not an agreement about now.
    confirmed_at TEXT,

    -- ---- the union, pushed down into the file -----------------------------
    --
    -- Four constraints, one per rung, each named so SQLite's own error says
    -- which rule was broken rather than only which table. Measured, not
    -- assumed: node:sqlite reports "CHECK constraint failed:
    -- verified_is_seen_and_agreed", and a person reading that has something
    -- they can act on.
    --
    -- Every one is phrased "this rung, or nothing to check", which is why the
    -- CHECK on \`state\` above is not decoration: an unlisted state would
    -- satisfy all four vacuously.

    CONSTRAINT unknown_says_nothing CHECK (
      state <> 'unknown' OR (
        answer IS NULL AND picked_json IS NULL AND evidence_json IS NULL
        AND stated_picked_json IS NULL
        AND stated_answer IS NULL AND confirmed_at IS NULL
      )
    ),

    -- 'stated' is a claim and only a claim. Evidence here would be a sighting
    -- filed under the rung that means nothing was seen.
    CONSTRAINT stated_is_only_what_was_said CHECK (
      state <> 'stated' OR (
        answer IS NOT NULL AND picked_json IS NOT NULL AND stated_picked_json IS NULL
        AND evidence_json IS NULL AND stated_answer IS NULL
        AND confirmed_at IS NULL
      )
    ),

    -- 'suspected' and 'observed' differ in how strongly the same kind of
    -- sighting is stated, so they carry the same columns and share one
    -- constraint. An empty evidence array is refused here rather than left to
    -- read as "seen, but we cannot say what" — which is a sentence this
    -- product is not allowed to write.
    CONSTRAINT a_sighting_names_what_was_seen CHECK (
      state NOT IN ('suspected', 'observed') OR (
        evidence_json IS NOT NULL AND json_array_length(evidence_json) >= 1
        AND answer IS NULL AND picked_json IS NULL AND confirmed_at IS NULL
        -- stated_picked_json is deliberately NOT forced null here: it is the
        -- one thing these two rungs carry beyond the sighting, and it travels
        -- with stated_answer.
      )
    ),

    -- 🟥 The one the whole table shape was chosen for. 'verified' is the only
    -- rung that asserts a person agreed, and it may not exist without both
    -- halves of what that means: something they were shown, and when they
    -- said so. A blank \`confirmed_at\` is refused alongside a missing one,
    -- because a whitespace timestamp passes every presence check and dates
    -- nothing.
    --
    -- 🟥 \`trim()\`, not \`<> ''\` — found 2026-08-28 by writing the row with raw
    -- SQL instead of through \`saveProfile\`. The comment above already claimed
    -- whitespace was refused; \`confirmed_at <> ''\` accepted \`'  '\` and the
    -- claim was false for exactly the value it named. The same hole \`saying()\`
    -- exists to close on a finding's prose, in a column nobody would think to
    -- look at twice.
    --
    -- \`stated_answer\` is NULL here because the contract's \`verified\` has
    -- nowhere to put one: agreement replaces the comparison rather than
    -- sitting beside it.
    CONSTRAINT verified_is_seen_and_agreed CHECK (
      state <> 'verified' OR (
        evidence_json IS NOT NULL AND json_array_length(evidence_json) >= 1
        AND confirmed_at IS NOT NULL AND trim(confirmed_at) <> ''
        AND answer IS NULL AND picked_json IS NULL AND stated_answer IS NULL
        AND stated_picked_json IS NULL
      )
    ),

    PRIMARY KEY (database_id, area)
  ) STRICT
  `,

  /**
   * The map of one database — ideal §31.
   *
   * A row per database and nothing else, which looks like an empty table until
   * you ask what its absence means. `entity_edge` alone could not tell *"this
   * database has no relationships"* apart from *"nobody has built a map"*, and
   * those are opposite sentences to say to somebody who has just inherited a
   * system. This row is what makes the first one sayable.
   */
  `
  CREATE TABLE entity_map (
    database_id INTEGER PRIMARY KEY REFERENCES scanned_database(id) ON DELETE CASCADE,

    -- Stored as it arrived, like project_profile.updated_at and for the same
    -- reason: there is one map per database, nothing orders by this, and
    -- normalising would cost exactness to buy nothing.
    built_at TEXT NOT NULL CHECK (trim(built_at) <> '')
  ) STRICT
  `,

  /**
   * One connection, and what earns it.
   *
   * ## The constraint that is the point of this table
   *
   * `rate_belongs_to_measured`. The contract's `EntityEdge` is a discriminated
   * union on `tier`, and the whole content of that union is which fields may
   * exist at which tier — `matched` belongs to `measured` and to nothing else.
   * Written as a blob, that rule would live only in the code that writes the
   * blob, and this file's header says what that is worth: the second writer
   * (an import tool, a repair script at 2am, somebody with the sqlite3 CLI)
   * will not know it existed.
   *
   * What it stops is specific. A `declared` edge carrying `of=100, found=60`
   * reads as though somebody counted and found 60% of an enforced constraint
   * holding — a number with no counting behind it, in front of a person whose
   * entire reason for being here is that they cannot check it themselves. The
   * contract refuses it. So does this.
   *
   * `found <= of` for the same reason: a rate above one is not a strong edge,
   * it is a bug in whatever counted, and it would print an impossible
   * percentage.
   *
   * ## Why `why` is checked with trim()
   *
   * 🟥 `why` is where every limit of an edge lives, and the limits are not
   * decoration. Measured 2026-08-28: all 758 of MusicBrainz's foreign keys are
   * `NOT VALID`, and 49 of Pagila's 55 `payment` partitions are not covered by
   * the key the other 6 declare. In both cases the tier stays `declared` and
   * the ONLY thing standing between a reader and an overclaim is this string.
   * An edge with a blank `why` is an enforcement claim with its limit deleted.
   *
   * `trim()`, not `<> ''`, because `<> ''` accepts `'  '` — the exact hole
   * found in `verified_is_seen_and_agreed` on the day this was written, in a
   * column nobody would think to look at twice.
   */
  `
  CREATE TABLE entity_edge (
    database_id INTEGER NOT NULL
      REFERENCES entity_map(database_id) ON DELETE CASCADE,

    from_schema TEXT NOT NULL CHECK (trim(from_schema) <> ''),
    from_table  TEXT NOT NULL CHECK (trim(from_table)  <> ''),
    to_schema   TEXT NOT NULL CHECK (trim(to_schema)   <> ''),
    to_table    TEXT NOT NULL CHECK (trim(to_table)    <> ''),

    -- The child column, always. An edge nobody can point at is an edge nobody
    -- can check, and this product does not get to assert those.
    via  TEXT NOT NULL CHECK (trim(via) <> ''),
    tier TEXT NOT NULL CHECK (tier IN (${EDGE_TIERS_SQL})),
    why  TEXT NOT NULL CHECK (trim(why) <> ''),

    matched_of    INTEGER CHECK (matched_of    IS NULL OR matched_of    >= 0),
    matched_found INTEGER CHECK (matched_found IS NULL OR matched_found >= 0),

    CONSTRAINT rate_belongs_to_measured CHECK (
      (tier = 'measured') = (matched_of IS NOT NULL)
      AND (matched_of IS NULL) = (matched_found IS NULL)
      AND (matched_found IS NULL OR matched_found <= matched_of)
    ),

    -- One relationship is one row. A table can point at the same parent twice
    -- through different columns and those are two relationships, which is why
    -- \`via\` is in the key rather than just the two ends.
    PRIMARY KEY (database_id, from_schema, from_table, via, to_schema, to_table)
  ) STRICT
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

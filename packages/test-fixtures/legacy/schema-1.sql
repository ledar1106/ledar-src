CREATE TABLE store_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

CREATE TABLE scanned_database (
    id            INTEGER PRIMARY KEY,
    fingerprint   TEXT NOT NULL UNIQUE,
    label         TEXT NOT NULL,
    first_seen_at TEXT NOT NULL
  ) STRICT;

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

    CHECK ((outcome = 'running') = (finished_at IS NULL)),
    CHECK (cost_truncated = 1 OR truncation_note IS NULL)
  ) STRICT;

CREATE TABLE run_rule (
    run_id       INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    rule         TEXT NOT NULL,
    ran          INTEGER NOT NULL CHECK (ran IN (0, 1)),
    checked      INTEGER CHECK (checked IS NULL OR checked >= 0),
    eligible     INTEGER CHECK (eligible IS NULL OR eligible >= 0),
    skipped      INTEGER CHECK (skipped IS NULL OR skipped >= 0),
    truncated_at INTEGER,
    note         TEXT,
    PRIMARY KEY (run_id, rule)
  ) STRICT;

CREATE TABLE finding (
    id             INTEGER PRIMARY KEY,
    run_id         INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    database_id    INTEGER NOT NULL REFERENCES scanned_database(id) ON DELETE CASCADE,

    finding_key    TEXT NOT NULL,
    structure_hash TEXT NOT NULL,

    rule         TEXT NOT NULL,
    kind         TEXT NOT NULL,
    confidence   TEXT NOT NULL,
    severity     TEXT NOT NULL,
    schema_name  TEXT NOT NULL,
    table_name   TEXT NOT NULL,
    columns_json TEXT NOT NULL,

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

    UNIQUE (run_id, finding_key),

    CHECK ((kind = 'negative') = (boundary IS NOT NULL)),
    -- The same rule sealFindings enforces, kept here too: "I found nothing"
    -- is only worth reading beside "out of how many". A negative claim with
    -- no denominator must not survive a round trip through this file, whoever
    -- wrote it.
    CHECK (kind != 'negative' OR coverage_eligible IS NOT NULL),
    CHECK ((evidence_sql IS NULL) = (evidence_row_count IS NULL))
  ) STRICT;

CREATE INDEX run_by_database ON run (database_id, started_at DESC);

CREATE INDEX finding_history ON finding (database_id, finding_key, run_id);

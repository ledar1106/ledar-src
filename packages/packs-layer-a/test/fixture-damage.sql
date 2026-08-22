-- ============================================================
--  Fixture: hong CO Y, de kiem bo quet co bat DUNG cai da cam khong.
--
--  Chay tren mot ban Pagila SACH. Moi cau duoi day cam MOT loi
--  co dinh, co so luong biet truoc, de test khang dinh chinh xac
--  chu khong phai "co tim thay gi do".
--
--  KHONG BAO GIO chay tren database that.
-- ============================================================

-- ============================================================
--  RE-RUNNABLE, FROM SCRATCH OR ON TOP OF ITSELF  (debt N21)
--
--  Every block below drops its own tables before creating them, and grants
--  SELECT to ledar_reader in the same block as the CREATE that needs it.
--  Loading this file twice in a row under `-v ON_ERROR_STOP=1` is expected to
--  exit 0 both times and to leave exactly the same faults behind.
--
--  Both halves of that are here because both have already gone wrong:
--
--    no DROP    Damage 1-5 had none, so replaying the file against a
--               container that already held them failed at the first CREATE
--               and left every later block unloaded — a half-loaded fixture
--               that looks loaded from the outside.
--
--    no GRANT   Damage 1-5 relied on a `GRANT ... ON ALL TABLES` run out of
--               band afterwards (infra/CALIBRATE.md, step 1). That works
--               exactly once. A dropped table takes its grants with it, and
--               every catalog query in
--               packages/connector-postgres/src/schema.ts is filtered by
--               has_table_privilege(c.oid, 'SELECT') — so a table the reader
--               role cannot select from is not empty to the scanner, it is
--               ABSENT, and the scanner reports nothing about it with total
--               confidence. That is the exact failure this product exists to
--               catch, sitting inside its own setup instructions.
--
--  Each GRANT is wrapped in a guard because on a freshly built container this
--  file is loaded before the role exists, and an unguarded GRANT would abort
--  the whole block.
--
--  What did NOT change: the faults themselves. Every count several suites
--  assert exactly is the same count it was.
-- ============================================================

BEGIN;

-- ── DAMAGE 1 ─────────────────────────────────────────────────
-- FK NOT VALID co 3 dong mo coi.
-- Postgres kiem dong MOI, bo qua dong CU. Day la cach duy nhat
-- mot foreign key da khai bao van co the bi vi pham.
-- KY VONG: layer-a/unvalidated-foreign-key-has-orphans, rowCount = 3
DROP TABLE IF EXISTS damaged_rental_note;

CREATE TABLE damaged_rental_note (
    id            serial PRIMARY KEY,
    rental_id     integer NOT NULL,
    note          text
);

INSERT INTO damaged_rental_note (rental_id, note)
SELECT rental_id, 'ok' FROM rental LIMIT 20;

INSERT INTO damaged_rental_note (rental_id, note)
VALUES (999000001, 'mo coi'), (999000002, 'mo coi'), (999000003, 'mo coi');

ALTER TABLE damaged_rental_note
  ADD CONSTRAINT damaged_rental_note_rental_fkey
  FOREIGN KEY (rental_id) REFERENCES rental(rental_id) NOT VALID;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledar_reader') THEN
    GRANT SELECT ON damaged_rental_note TO ledar_reader;
  END IF;
END
$$;

-- ── DAMAGE 2 ─────────────────────────────────────────────────
-- CHECK NOT VALID bi 4 dong vi pham.
-- KY VONG: layer-a/unvalidated-check-is-violated, rowCount = 4
DROP TABLE IF EXISTS damaged_payment_audit;

CREATE TABLE damaged_payment_audit (
    id           serial PRIMARY KEY,
    amount_cents integer NOT NULL
);

INSERT INTO damaged_payment_audit (amount_cents)
VALUES (100), (250), (999), (-1), (-50), (-7), (-1000);

ALTER TABLE damaged_payment_audit
  ADD CONSTRAINT damaged_payment_audit_amount_positive
  CHECK (amount_cents >= 0) NOT VALID;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledar_reader') THEN
    GRANT SELECT ON damaged_payment_audit TO ledar_reader;
  END IF;
END
$$;

-- ── DAMAGE 3 ─────────────────────────────────────────────────
-- Cot trong nhu khoa ngoai nhung KHONG AI khai bao, va co 5 dong
-- tro vao khach hang khong ton tai. 20 dong con lai khop.
-- Ty le khop 80% -> tren nguong 50%, nen phai duoc neu ra.
-- KY VONG: layer-b/undeclared-reference-with-unmatched-values
--          rowCount = 5, sampleSize = 25
DROP TABLE IF EXISTS damaged_invoice;

CREATE TABLE damaged_invoice (
    id           serial PRIMARY KEY,
    customer_id  integer,
    total_cents  integer NOT NULL DEFAULT 0
);

INSERT INTO damaged_invoice (customer_id, total_cents)
SELECT customer_id, 1000 FROM customer LIMIT 20;

INSERT INTO damaged_invoice (customer_id, total_cents)
VALUES (888001, 100), (888002, 100), (888003, 100), (888004, 100), (888005, 100);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledar_reader') THEN
    GRANT SELECT ON damaged_invoice TO ledar_reader;
  END IF;
END
$$;

-- ── DAMAGE 4 ─────────────────────────────────────────────────
-- Ten cot goi y mot bang cha, nhung gia tri hoan toan khong khop.
-- Ty le khop 0% -> DUOI nguong, phai bi TU CHOI, khong duoc neu ra.
-- Day la test chong DUONG TINH GIA, quan trong ngang test bat loi.
-- KY VONG: KHONG co finding nao cho bang nay
DROP TABLE IF EXISTS damaged_external_ref;

CREATE TABLE damaged_external_ref (
    id          serial PRIMARY KEY,
    staff_id    integer   -- thuc ra la ID cua he thong khac
);

INSERT INTO damaged_external_ref (staff_id)
SELECT g FROM generate_series(700001, 700030) g;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledar_reader') THEN
    GRANT SELECT ON damaged_external_ref TO ledar_reader;
  END IF;
END
$$;

COMMIT;

-- ── DAMAGE 5 ─────────────────────────────────────────────────
-- Index unique bi bo do — khong con rang buoc gi.
-- Khong the tao trong transaction, nen de ngoai.
-- KY VONG: layer-a/index-not-enforcing, severity = high
DROP TABLE IF EXISTS damaged_slug;

CREATE TABLE damaged_slug (
    id   serial PRIMARY KEY,
    slug text
);
INSERT INTO damaged_slug (slug) VALUES ('a'), ('b'), ('c');

CREATE UNIQUE INDEX damaged_slug_unique ON damaged_slug (slug);
UPDATE pg_index SET indisvalid = false
WHERE indexrelid = 'damaged_slug_unique'::regclass;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledar_reader') THEN
    GRANT SELECT ON damaged_slug TO ledar_reader;
  END IF;
END
$$;

-- ============================================================
--  TONG KY VONG cho DAMAGE 1-5 (khoi tren)
--    Tang A: 3 phat hien  (fk orphans=3 · check violations=4 · index hong)
--    Tang B: 1 phat hien  (damaged_invoice.customer_id, orphans=5)
--    KHONG neu: damaged_external_ref.staff_id (khop 0%)
--
--  KHONG PHAI tong ky vong cua CA FILE. DAMAGE 6-9 duoc them sau
--  va co bang tong ket rieng o cuoi file. Con so day du: 4 Tang A +
--  3 Tang B + 1 bay + 1 khong-xet. Doc bang o cuoi truoc khi trich
--  so tu day.
-- ============================================================

-- ============================================================
--  DAMAGE 6 and 7 — appended later. The five faults above kept their
--  known counts, which several suites assert exactly; they gained a
--  `DROP TABLE IF EXISTS` and a guarded `GRANT` apiece so the file can be
--  replayed (debt N21), and nothing else.
--
--  WHY THIS EXISTS  (HANDOFF-STATUS.md section 1c, debt N15)
--
--  redactCell() in packages/contracts/src/redaction.ts can produce four
--  shapes: <number>, <text:N>, <uuid> and 'null'. Until this block, only
--  <number> had ever been produced from a value that came out of Postgres
--  — both orphan columns in the fixture above hold integers, so the other
--  three branches lived only in unit tests over hand-written values.
--
--  That gap is not theoretical. There were once three copies of that
--  function, they agreed on every case except the empty cell, and nobody
--  noticed for months, because the branch where they disagreed was the
--  branch no query could reach. A redaction branch nobody runs is where a
--  safety rule drifts, and the branch that goes live first is the branch
--  nobody tested. So the two shapes that CAN be reached are reached here,
--  on real rows, through the real packs.
--
--  TWO NAMING CONVENTIONS, ON PURPOSE
--
--  parentNameGuesses() in packages/packs-layer-b/src/implicit-fk.ts reads
--  a column name two ways, and the second one was invisible to it until
--  MusicBrainz turned up with a schema that has used it since 2000:
--
--    damaged_tag_link.damaged_tag_id   -> damaged_tag    (suffix: _id)
--    damaged_asset_link.damaged_asset  -> damaged_asset  (bare: name = table)
--
--  typesCompatible() in the same file pairs int2/int4/int8 with each other
--  and everything else only with itself, so each parent primary key carries
--  the type its child column has to match: text and uuid, not serial.
-- ============================================================

BEGIN;

DROP TABLE IF EXISTS damaged_tag_link;
DROP TABLE IF EXISTS damaged_tag;
DROP TABLE IF EXISTS damaged_asset_link;
DROP TABLE IF EXISTS damaged_asset;

-- ── DAMAGE 6 ─────────────────────────────────────────────────
-- A text column that behaves like a foreign key and has 3 broken links.
-- 9 of the 12 non-empty values line up with damaged_tag (75%), which is
-- above the 50% threshold, so this one has to be raised.
--
-- EXPECT: layer-b/undeclared-reference-with-unmatched-values
--         damaged_tag_link.damaged_tag_id · rowCount = 3 · sampleSize = 12
--         every sampled cell redacted to <text:N>
CREATE TABLE damaged_tag (
    tag_slug text PRIMARY KEY
);

INSERT INTO damaged_tag (tag_slug)
VALUES ('release-window-north'),
       ('release-window-south'),
       ('retired-shelf-label');

CREATE TABLE damaged_tag_link (
    id             serial PRIMARY KEY,
    damaged_tag_id text
);

-- Nine that match.
INSERT INTO damaged_tag_link (damaged_tag_id)
VALUES ('release-window-north'),
       ('release-window-north'),
       ('release-window-north'),
       ('release-window-south'),
       ('release-window-south'),
       ('release-window-south'),
       ('retired-shelf-label'),
       ('retired-shelf-label'),
       ('retired-shelf-label');

-- Three that point at a tag nobody kept. These three strings are what the
-- redaction suites hunt for byte by byte in the history file, so they are
-- long enough to tell apart from noise and contain letters outside [0-9a-f]
-- — a value that looked like hex would be redacted to <uuid> instead.
INSERT INTO damaged_tag_link (damaged_tag_id)
VALUES ('orphan-tag-vanished-alpha'),
       ('orphan-tag-vanished-beta'),
       ('orphan-tag-vanished-gamma');

-- Two empty cells, and they are NOT coverage of redactCell's null branch.
-- Read this before assuming otherwise: buildOrphanSample() in layer B and
-- buildOrphanSampleQuery() in layer A both select only the candidate
-- columns and both require every one of them to be IS NOT NULL, so an
-- empty cell cannot reach redactCell at all — the null branch is
-- unreachable by construction, not merely unused.
--
-- These rows are a tripwire for the day that stops being true. If anyone
-- drops the IS NOT NULL filter — sampling whole rows, say — these cells
-- become reachable, 'null' starts appearing in samples, and the suites
-- that count sampled rows go red the same day instead of months later.
INSERT INTO damaged_tag_link (damaged_tag_id)
VALUES (NULL), (NULL);

-- ── DAMAGE 7 ─────────────────────────────────────────────────
-- The same shape again with uuid values, and named the other way: the
-- column carries the parent table's name outright, with no _id suffix.
-- 9 of 12 non-empty values line up (75%).
--
-- EXPECT: layer-b/undeclared-reference-with-unmatched-values
--         damaged_asset_link.damaged_asset · rowCount = 3 · sampleSize = 12
--         every sampled cell redacted to <uuid>
CREATE TABLE damaged_asset (
    asset_key uuid PRIMARY KEY
);

INSERT INTO damaged_asset (asset_key)
VALUES ('3f2504e0-4f89-41d3-9a0c-0305e82c3301'),
       ('3f2504e0-4f89-41d3-9a0c-0305e82c3302'),
       ('3f2504e0-4f89-41d3-9a0c-0305e82c3303');

CREATE TABLE damaged_asset_link (
    id            serial PRIMARY KEY,
    damaged_asset uuid
);

-- Nine that match.
INSERT INTO damaged_asset_link (damaged_asset)
VALUES ('3f2504e0-4f89-41d3-9a0c-0305e82c3301'),
       ('3f2504e0-4f89-41d3-9a0c-0305e82c3301'),
       ('3f2504e0-4f89-41d3-9a0c-0305e82c3301'),
       ('3f2504e0-4f89-41d3-9a0c-0305e82c3302'),
       ('3f2504e0-4f89-41d3-9a0c-0305e82c3302'),
       ('3f2504e0-4f89-41d3-9a0c-0305e82c3302'),
       ('3f2504e0-4f89-41d3-9a0c-0305e82c3303'),
       ('3f2504e0-4f89-41d3-9a0c-0305e82c3303'),
       ('3f2504e0-4f89-41d3-9a0c-0305e82c3303');

-- Three that point at an asset nobody kept. Written in lower case because
-- Postgres normalises uuid text that way on the way back out, and these
-- are the exact strings the byte search looks for.
INSERT INTO damaged_asset_link (damaged_asset)
VALUES ('9d4f6a2b-77c1-4e58-9b30-5a1c2d3e4f01'),
       ('9d4f6a2b-77c1-4e58-9b30-5a1c2d3e4f02'),
       ('9d4f6a2b-77c1-4e58-9b30-5a1c2d3e4f03');

-- The same tripwire as above, for the same reason.
INSERT INTO damaged_asset_link (damaged_asset)
VALUES (NULL), (NULL);

-- ── ACCESS ───────────────────────────────────────────────────
-- Without this the four tables above do not exist as far as the scanner
-- is concerned. See the RE-RUNNABLE note at the top of the file for why a
-- table the reader role cannot select from reads as absent rather than as
-- empty, and why that is the worst answer a scanner can give.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledar_reader') THEN
    GRANT SELECT ON damaged_tag, damaged_tag_link TO ledar_reader;
    GRANT SELECT ON damaged_asset, damaged_asset_link TO ledar_reader;
  END IF;
END
$$;

COMMIT;

-- ============================================================
--  DAMAGE 8 — the row-wise redactor, on values that are not integers
--
--  WHY THIS EXISTS  (HANDOFF-STATUS.md section 1c, debt N20)
--
--  Damage 6 and 7 brought <text:N> and <uuid> onto real rows, but only
--  through Layer B, which redacts one cell at a time with redactCell().
--  Layer A samples differently: it hands whole rows to redactRow(), and
--  every orphan column it had to work with held integers. So the function
--  the fact-stating layer uses had, on real data, only ever produced
--  <number> — the same gap N15 closed for the other layer.
--
--  A composite key on purpose, and it is not decoration. redactRow() is a
--  loop over the cells of one row, and with every sample in the fixture one
--  column wide that loop had never gone round twice. Here each sampled row
--  carries a text cell and a uuid cell, so one row exercises two branches
--  of redactCell and the loop that is the only thing redactRow adds.
--
--  It also puts a real composite NOT VALID foreign key in front of
--  buildOrphanQuery() and buildOrphanSampleQuery(), which build their join
--  and their IS NOT NULL filter column by column. Until now that was only
--  ever exercised by hand-built constraints in
--  test/sample-query-null-branch.test.ts.
--
--  EXPECT: layer-a/unvalidated-foreign-key-has-orphans
--          damaged_label_link (label_slug, label_key) · rowCount = 3
--          each sampled row: label_slug -> <text:N>, label_key -> <uuid>
-- ============================================================

BEGIN;

DROP TABLE IF EXISTS damaged_label_link;
DROP TABLE IF EXISTS damaged_label;

CREATE TABLE damaged_label (
    label_slug text,
    label_key  uuid,
    PRIMARY KEY (label_slug, label_key)
);

INSERT INTO damaged_label (label_slug, label_key)
VALUES ('retention-hold-north', '7c9e6679-7425-40de-944b-e07fc1f90ae1'),
       ('retention-hold-south', '7c9e6679-7425-40de-944b-e07fc1f90ae2'),
       ('retention-hold-east',  '7c9e6679-7425-40de-944b-e07fc1f90ae3');

CREATE TABLE damaged_label_link (
    id         serial PRIMARY KEY,
    label_slug text NOT NULL,
    label_key  uuid NOT NULL
);

-- Five links that resolve.
INSERT INTO damaged_label_link (label_slug, label_key)
VALUES ('retention-hold-north', '7c9e6679-7425-40de-944b-e07fc1f90ae1'),
       ('retention-hold-north', '7c9e6679-7425-40de-944b-e07fc1f90ae1'),
       ('retention-hold-south', '7c9e6679-7425-40de-944b-e07fc1f90ae2'),
       ('retention-hold-south', '7c9e6679-7425-40de-944b-e07fc1f90ae2'),
       ('retention-hold-east',  '7c9e6679-7425-40de-944b-e07fc1f90ae3');

-- Three that point at a label nobody kept. Both cells of each row are what
-- the byte search in packages/store/test/redaction-chain.pagila.test.ts
-- hunts for in the finished history file, so:
--   the slugs are longer than four characters, and carry letters outside
--   [0-9a-f] so they cannot be mistaken for hex and redacted to <uuid>;
--   the uuids are lower case, because Postgres hands them back that way and
--   these are the exact strings that search looks for.
INSERT INTO damaged_label_link (label_slug, label_key)
VALUES ('orphan-label-vanished-alpha', '5b8a1c04-2f6d-4e19-8c73-a0d2e5f6b701'),
       ('orphan-label-vanished-beta',  '5b8a1c04-2f6d-4e19-8c73-a0d2e5f6b702'),
       ('orphan-label-vanished-gamma', '5b8a1c04-2f6d-4e19-8c73-a0d2e5f6b703');

-- Declared last, and NOT VALID: Postgres checks rows inserted from here on
-- and leaves the eight above unexamined. The three orphans are already in
-- the table when the guarantee is written down, which is the only way a
-- declared foreign key can be violated.
ALTER TABLE damaged_label_link
  ADD CONSTRAINT damaged_label_link_label_fkey
  FOREIGN KEY (label_slug, label_key)
  REFERENCES damaged_label (label_slug, label_key) NOT VALID;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledar_reader') THEN
    GRANT SELECT ON damaged_label, damaged_label_link TO ledar_reader;
  END IF;
END
$$;

COMMIT;

-- ============================================================
--  DAMAGE 9 — the "did not check" branch, on the real path
--
--  ⚠ WHAT THIS TABLE PROVES CHANGED ON 2026-08-22. The rows and the sabotage
--    below are untouched; the branch they land in is not, and the old text is
--    kept above the new so the reason is legible rather than tidy.
--
--  WHAT IT USED TO PROVE  (debt N2)
--
--  runImplicitForeignKeys() set a candidate aside with
--  cause = 'table_too_large' when childRowsEstimated exceeded
--  ALWAYS_CHECK_BELOW_ROWS (500,000). Pagila has no table remotely that
--  size, so that branch — and the "did not check" group the CLI prints from
--  it — had never once run outside a unit test. Nobody knew what the
--  sentence looked like on screen.
--
--  WHAT IT PROVES NOW  (debt N32, and the reason N34's fix is safe)
--
--  There is no size refusal any more. Size picks the reading METHOD: at or
--  under EXACT_BELOW_ROWS (50,000) every value is counted, above it the table
--  is block-sampled, and nothing is turned away for being big. So this table
--  is now SAMPLED — at 10,000 / 900,000 = 1.1% of its blocks.
--
--  And it holds twelve rows in one block. A 1.1% draw from a one-block table
--  almost always comes back with nothing, which makes this fixture the proof
--  of a distinction the whole product rests on: present = 0 from a sample is
--  NOT the same as present = 0 from a count. One means nothing is there, the
--  other means nothing was seen. The rule now reports the second as
--  cause = 'sample_came_back_empty' and names the estimate it distrusts,
--  instead of calling the column clean.
--
--  That makes an overstated reltuples a REALISTIC fault rather than only a
--  cheap trick: stale statistics are ordinary, and this is what they do to a
--  sampler that trusts them.
--
--  NO ROWS ARE NEEDED, AND NONE ARE INSERTED
--
--  SIZES_SQL in packages/connector-postgres/src/schema.ts reads
--  `c.reltuples`, the planner's estimate. It is a number in a catalog, not a
--  measurement, so the fault is cut where the scanner reads it — the same
--  move damage 5 makes with `pg_index.indisvalid`. Twelve real rows and one
--  overstated estimate reproduce the exact condition of a table with nine
--  hundred thousand rows, at no storage cost.
--
--  ⚠ DO NOT RUN `ANALYZE` (OR `VACUUM ANALYZE`) ON damaged_bulk_link.
--  Either one recomputes reltuples from the real twelve rows, the candidate
--  drops back under the threshold, and the fault heals itself silently: the
--  suite that asserts this lands in notExamined would go red with no visible
--  cause, or worse, a later reader would "fix" the assertion. Autovacuum is
--  switched off on the table below for the same reason, and the raised
--  estimate is its own second line of defence — autoanalyze fires at
--  50 + 0.1 * reltuples changed rows, which is 100,000,050 once this is set.
--
--  EXPECT: NOT a finding. damaged_bulk_link.damaged_bulk_id lands in
--          LayerBOutcome.notExamined with cause = 'sample_came_back_empty',
--          and `candidatesVerified + notExamined.length <= candidatesConsidered`
--          still holds.
--
--  The three orphans are here so the candidate is ARMED. Correct the estimate
--  — ANALYZE, or the real rows growing into it — and this turns into a real
--  finding, which is a visible change rather than a silent one.
-- ============================================================

BEGIN;

DROP TABLE IF EXISTS damaged_bulk_link;
DROP TABLE IF EXISTS damaged_bulk;

CREATE TABLE damaged_bulk (
    id   integer PRIMARY KEY,
    note text
);

INSERT INTO damaged_bulk (id, note)
SELECT g, 'kept' FROM generate_series(1, 6) g;

CREATE TABLE damaged_bulk_link (
    id              serial PRIMARY KEY,
    damaged_bulk_id integer
);

-- Nine that match, three that do not. Twelve rows in total, deliberately
-- well under the 50 changed rows that would let autoanalyze fire before the
-- estimate below is in place.
INSERT INTO damaged_bulk_link (damaged_bulk_id)
VALUES (1), (1), (2), (2), (3), (3), (4), (5), (6),
       (777001), (777002), (777003);

-- First line of defence for the sabotage below: nothing may recompute this
-- table's estimate on its own schedule.
ALTER TABLE damaged_bulk_link SET (autovacuum_enabled = false);

-- The fault itself. `reltuples` is what SIZES_SQL reads and what
-- ImplicitFkCandidate.childRowsEstimated is built from, so overstating it
-- here is exactly the condition a genuinely large table presents to the
-- rule — no other code path is involved or bypassed.
-- ⚠ ONE BILLION, AND THE SIZE IS NOT ABOUT REALISM — IT IS ABOUT DETERMINISM.
--
-- This was 900,000, and at 900,000 the fixture was PROBABILISTIC. The sampled
-- path draws 10,000 / 900,000 = 1.11% of blocks; this table is twelve rows in
-- ONE block; so roughly one run in ninety drew that block, came back with all
-- twelve rows, and produced a FINDING instead of the empty sample every
-- assertion here depends on.
--
-- It took about fifteen full-suite runs to show, as a single red test in an
-- otherwise green run — which is the worst way for it to appear, because the
-- obvious reading is "flaky test" and the true reading is "the fixture has a
-- one-in-ninety second personality".
--
-- At 1e9 the percentage is 0.001% and the draw is effectively never taken. The
-- lie the catalog tells is bigger, and it is exactly the same KIND of lie —
-- which is all damage 9 was ever about.
--
-- A fixture that fires occasionally does not make the suite occasionally
-- wrong. It makes the suite lie about being green, which is worse.
UPDATE pg_class SET reltuples = 1000000000
WHERE oid = 'damaged_bulk_link'::regclass;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledar_reader') THEN
    GRANT SELECT ON damaged_bulk, damaged_bulk_link TO ledar_reader;
  END IF;
END
$$;

COMMIT;

-- ============================================================
--  DAMAGE 10 — a convention that looks exactly like mass breakage
--
--  WHY THIS EXISTS  (HANDOFF-STATUS.md section 1c, debt N33)
--
--  RubyGems.org has 232,818 rows in gem_downloads whose version_id matches
--  no versions record. 232,573 of them are the single value 0, which that
--  schema uses to mean "totals across every version of this gem". The match
--  rate was 89.4% — comfortably over MIN_MATCH_RATE — so the rule would have
--  raised a question about a quarter of a million rows of which 99.9% were a
--  deliberate design decision, on a database nobody in this project owns.
--
--  Nothing about the value gives it away. It is the number zero. This is the
--  same lesson as the redaction gate: the dangerous case has no shape to
--  detect. So what the rule measures is not the value but its CONCENTRATION
--  — scattered leftovers are scattered, a convention is one value repeated.
--
--  THE MIXED CASE, WHICH IS THE HARD ONE
--
--  This table is not pure sentinel. It is a sentinel WITH one genuine orphan
--  hiding behind it, and that is the case a cruder fix would get wrong:
--  ruling out the whole column on sight would suppress the false positive and
--  the real finding in the same move.
--
--  EXPECT: a finding on damaged_sentinel_link.damaged_sentinel_id reporting
--          ONE unmatched row, not twenty, and saying in its own words that a
--          further 19 sharing a single value were set aside.
-- ============================================================

BEGIN;

DROP TABLE IF EXISTS damaged_sentinel_link;
DROP TABLE IF EXISTS damaged_sentinel;

CREATE TABLE damaged_sentinel (
    id   integer PRIMARY KEY,
    note text
);

INSERT INTO damaged_sentinel (id, note)
SELECT g, 'kept' FROM generate_series(1, 6) g;

CREATE TABLE damaged_sentinel_link (
    id                   serial PRIMARY KEY,
    damaged_sentinel_id  integer
);

-- 80 that match.
INSERT INTO damaged_sentinel_link (damaged_sentinel_id)
SELECT (g % 6) + 1 FROM generate_series(1, 80) g;

-- 19 carrying the convention. Zero, like RubyGems, because zero is what
-- schemas reach for when they need a value that means "not one of them".
INSERT INTO damaged_sentinel_link (damaged_sentinel_id)
SELECT 0 FROM generate_series(1, 19) g;

-- And one real orphan, which is the whole point of the mixed case: it must
-- survive the sentinel being set aside.
INSERT INTO damaged_sentinel_link (damaged_sentinel_id) VALUES (999001);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledar_reader') THEN
    GRANT SELECT ON damaged_sentinel, damaged_sentinel_link TO ledar_reader;
  END IF;
END
$$;

COMMIT;

-- ============================================================
--  DAMAGE 11 — the same convention with nothing behind it
--
--  WHY THIS EXISTS  (HANDOFF-STATUS.md section 1c, debt N33)
--
--  Damage 10 proves the residual survives. This one proves the other half:
--  when the sentinel is ALL of it, the rule says nothing to the user and says
--  so out loud in `ruledOut`, rather than either raising it or dropping it
--  silently. Restraint that leaves no trace cannot be told apart from not
--  having looked.
--
--  EXPECT: NOT a finding. damaged_convention_link.damaged_convention_id lands
--          in LayerBOutcome.ruledOut with
--          cause = 'unmatched_is_one_repeated_value'  — and NOT in
--          notExamined, because the query ran and the values were counted.
-- ============================================================

BEGIN;

DROP TABLE IF EXISTS damaged_convention_link;
DROP TABLE IF EXISTS damaged_convention;

CREATE TABLE damaged_convention (
    id   integer PRIMARY KEY,
    note text
);

INSERT INTO damaged_convention (id, note)
SELECT g, 'kept' FROM generate_series(1, 6) g;

CREATE TABLE damaged_convention_link (
    id                     serial PRIMARY KEY,
    damaged_convention_id  integer
);

INSERT INTO damaged_convention_link (damaged_convention_id)
SELECT (g % 6) + 1 FROM generate_series(1, 80) g;

INSERT INTO damaged_convention_link (damaged_convention_id)
SELECT 0 FROM generate_series(1, 20) g;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledar_reader') THEN
    GRANT SELECT ON damaged_convention, damaged_convention_link TO ledar_reader;
  END IF;
END
$$;

COMMIT;

-- ============================================================
--  DAMAGE 12 — the fault that lives only in the part of the table
--              the old sampler never read
--
--  WHY THIS EXISTS  (HANDOFF-STATUS.md section 1c, debt N34)
--
--  buildMatchQuery used `LIMIT 10000` with no ORDER BY. That does not mean
--  "ten thousand rows", it means "whatever ten thousand rows come out of the
--  heap first" — on an append-mostly table, the ten thousand OLDEST.
--
--  Measured on devops.stackexchange: reported 200 unmatched of 10,000 and
--  printed "98.0% match". The whole column is 6,459 of 49,148 — 13.1%. Off
--  by 6.5x, and off toward the reassuring answer, because orphans accumulate
--  over time and the oldest rows are the cleanest.
--
--  THIS TABLE IS THE DANGEROUS VERSION OF THAT
--
--  Not "the number was a bit off". The first 42,000 rows are spotless. Every
--  unmatched value is in the last 18,000, which is what a fault that STARTED
--  RECENTLY looks like on disk. The old sampler reads the first ten thousand,
--  finds nothing wrong, and the rule returns orphans = 0 — no finding, no
--  ruled-out entry, no mention anywhere in the coverage strip. The column is
--  reported as clean, in the product's own confident voice.
--
--  DO NOT REWRITE THE ROW ORDER. It is the fixture. Interleaving the orphans,
--  CLUSTER, or VACUUM FULL all spread the fault evenly through the heap — at
--  which point reading the first ten thousand rows finds it, and this table
--  proves nothing while still looking like it does.
--
--  60,000 is not arbitrary either. It has to clear EXACT_BELOW_ROWS (50,000)
--  to take the sampled path at all, and it has to span enough blocks that a
--  block sample reliably reaches the tail.
--
--  EXPECT: a finding on damaged_wide_link.damaged_wide_id, with an unmatched
--          share somewhere near 30% — it is a SAMPLE, so the number moves
--          between runs, and a test that pins it exactly is testing the seed
--          rather than the rule.
-- ============================================================

BEGIN;

DROP TABLE IF EXISTS damaged_wide_link;
DROP TABLE IF EXISTS damaged_wide;

CREATE TABLE damaged_wide (
    id   integer PRIMARY KEY,
    note text
);

INSERT INTO damaged_wide (id, note)
SELECT g, 'kept' FROM generate_series(1, 6) g;

CREATE TABLE damaged_wide_link (
    id              serial PRIMARY KEY,
    damaged_wide_id integer
);

-- The clean history: 42,000 rows, every one of them matching.
INSERT INTO damaged_wide_link (damaged_wide_id)
SELECT (g % 6) + 1 FROM generate_series(1, 42000) g;

-- The recent damage: 18,000 rows pointing at nothing, all of them physically
-- after the clean rows. This is the half the old sampler could not reach.
INSERT INTO damaged_wide_link (damaged_wide_id)
SELECT 888000 + g FROM generate_series(1, 18000) g;

-- Unlike damage 9, this table's estimate is meant to be HONEST. The sampling
-- percentage is derived from reltuples, so a stale estimate here would change
-- how much of the table gets drawn — which is a different fault than the one
-- this table is for.
ANALYZE damaged_wide_link;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledar_reader') THEN
    GRANT SELECT ON damaged_wide, damaged_wide_link TO ledar_reader;
  END IF;
END
$$;

COMMIT;

-- ============================================================
--  DAMAGE 13 — the table with nothing in it, which is not the same
--              as the table with nothing wrong in it
--
--  WHY THIS EXISTS  (HANDOFF-STATUS.md section 1c, debt N39)
--
--  Found on MusicBrainz, 2026-08-22, and it is the clearest case anyone is
--  likely to get. 374 tables, 344 million rows — and all seven of Layer B's
--  candidates sat on derived tables the public dump ships EMPTY. The report
--  then said:
--
--      "checked 7 of them against real values"
--
--  three lines below a header of its own saying:
--
--      "164 of 374 tables hold no rows"
--
--  Both sentences came out of the same run. Nothing was wrong with the
--  arithmetic — a query ran and answered, so the column is checked work. What
--  was wrong was the sentence built on top of it: there were no values.
--
--  THIS IS THE FOURTH KIND OF ZERO
--
--      counted, none there          nothing is wrong        (already said)
--      sampled, draw came back empty nothing was seen       (already said)
--      sampled, rows but no orphans  nothing in what I saw  (already said)
--      table holds no rows           nothing to compare     ← this one
--
--  ⚠ THE EMPTINESS IS THE FIXTURE. Do not insert rows into
--    damaged_empty_link to "make it a better test". The moment it holds a
--    row it stops being this test, and the assertion that reads it will go
--    on passing while proving nothing — which is exactly how this defect
--    survived until a 344-million-row database made it visible.
--
--  The parent is NOT empty on purpose: an empty parent would make the
--  candidate uninteresting for a different reason, and the point is that
--  everything about this pair looks checkable right up until the child is
--  read.
--
--  EXPECT: damaged_empty_link.damaged_empty_id is a CANDIDATE, is CHECKED
--          (a query runs), produces NO finding, and is counted in
--          LayerBOutcome.columnsWithNoRows.
-- ============================================================

BEGIN;

DROP TABLE IF EXISTS damaged_empty_link;
DROP TABLE IF EXISTS damaged_empty;

CREATE TABLE damaged_empty (
    id   integer PRIMARY KEY,
    note text
);

INSERT INTO damaged_empty (id, note)
SELECT g, 'kept' FROM generate_series(1, 6) g;

-- Zero rows, and it stays that way. See the warning above.
CREATE TABLE damaged_empty_link (
    id                serial PRIMARY KEY,
    damaged_empty_id  integer
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledar_reader') THEN
    GRANT SELECT ON damaged_empty, damaged_empty_link TO ledar_reader;
  END IF;
END
$$;

COMMIT;

-- ============================================================
--  DAMAGE 14 — one unmatched row is not a convention
--
--  WHY THIS EXISTS  (HANDOFF-STATUS.md section 1c, debt N38)
--
--  The sentinel rule sets a value aside when it covers >= 80% of everything
--  that did not match, on the reasoning that "a convention is one value, over
--  and over". That reasoning has a hole at the bottom, and the hole is
--  arithmetic: with exactly ONE unmatched row, the dominant value covers
--  100% of the unmatched set. It clears 0.8 without effort. The column is
--  then ruled out as a schema convention on the strength of a single row —
--  and there is no "over and over" anywhere in it.
--
--  NOT HYPOTHETICAL. Found 2026-08-22 by measuring the dominance of every
--  Layer B candidate across six benches, which is what debt N38 asked for:
--
--      se_dba.posts.owner_user_id   242,133 rows · 1 unmatched · 100.0%
--
--  A real column, on a real database, whose one broken link vanished into
--  `ruledOut` under a reason that was untrue of it. The suppression was
--  disclosed rather than silent, which is the only reason this is a defect
--  and not a disaster.
--
--  The fix is not a tuned threshold. It is that "repeated" has to mean
--  repeated: SENTINEL_MIN_REPEATS = 2.
--
--  ⚠ ONE ORPHAN IS THE FIXTURE. Adding a second unmatched row with the same
--    value turns this into the sentinel case and the assertion below starts
--    passing for the opposite reason. Adding one with a DIFFERENT value drops
--    dominance to 50% and the assertion passes without the guard existing at
--    all. Exactly one, and it must be the only one.
--
--  EXPECT: a finding on damaged_lonely_link.damaged_lonely_id reporting ONE
--          unmatched row — NOT a ruledOut entry, and not a set-aside.
-- ============================================================

BEGIN;

DROP TABLE IF EXISTS damaged_lonely_link;
DROP TABLE IF EXISTS damaged_lonely;

CREATE TABLE damaged_lonely (
    id   integer PRIMARY KEY,
    note text
);

INSERT INTO damaged_lonely (id, note)
SELECT g, 'kept' FROM generate_series(1, 6) g;

CREATE TABLE damaged_lonely_link (
    id                serial PRIMARY KEY,
    damaged_lonely_id integer
);

-- 99 that match.
INSERT INTO damaged_lonely_link (damaged_lonely_id)
SELECT (g % 6) + 1 FROM generate_series(1, 99) g;

-- And exactly one that does not. See the warning above before touching this.
INSERT INTO damaged_lonely_link (damaged_lonely_id) VALUES (999002);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledar_reader') THEN
    GRANT SELECT ON damaged_lonely, damaged_lonely_link TO ledar_reader;
  END IF;
END
$$;

COMMIT;

-- ============================================================
--  TOTAL EXPECTATION, damage 1-14
--    Layer A: 4 findings  (fk orphans=3 · check violations=4 · dead index
--                          · damaged_label_link composite fk orphans=3)
--    Layer B: 6 findings  (damaged_invoice.customer_id           orphans=5
--                          damaged_tag_link.damaged_tag_id       orphans=3
--                          damaged_asset_link.damaged_asset      orphans=3
--                          damaged_sentinel_link.…_sentinel_id   orphans=1
--                            after setting 19 sentinel rows aside
--                          damaged_wide_link.damaged_wide_id     ~30% of a
--                            SAMPLE — the one number here that moves per run
--                          damaged_lonely_link.…_lonely_id       orphans=1
--                            ONE unmatched row is not a convention)
--    Ruled out (checked, then let go):
--                         damaged_external_ref.staff_id (0% match)
--                         damaged_convention_link.damaged_convention_id
--                         (cause: unmatched_is_one_repeated_value)
--    Not examined (never queried):
--                         damaged_bulk_link.damaged_bulk_id
--                         (cause: sample_came_back_empty)
--    Checked, but with nothing to compare:
--                         damaged_empty_link.damaged_empty_id
--                         (table holds zero rows — counted in
--                          LayerBOutcome.columnsWithNoRows)
--
--    Redacted sample shapes reached from real rows:
--      <number>   damaged_rental_note.rental_id · damaged_invoice.customer_id
--      <text:N>   damaged_tag_link.damaged_tag_id  (layer B, redactCell)
--                 damaged_label_link.label_slug    (layer A, redactRow)
--      <uuid>     damaged_asset_link.damaged_asset (layer B, redactCell)
--                 damaged_label_link.label_key     (layer A, redactRow)
--      'null'     unreachable — see the tripwire note under damage 6
-- ============================================================

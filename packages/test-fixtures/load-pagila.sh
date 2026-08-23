#!/usr/bin/env bash
#
# Stands up the Pagila regression fixture from nothing — the 14 deliberate
# faults the detection rules are measured against.
#
# This is the runbook from infra/CALIBRATE.md ① turned into a command, for the
# same reason `rebuild-musicbrainz.sh` was: a runbook is a thing somebody
# performs slightly differently each time, and one of those times they skip the
# GRANT.
#
# It lives in @ledar/test-fixtures rather than in infra/ because that package
# is already "shared access to the local fixture databases", and because infra/
# does not publish — a loader CI cannot reach is a loader CI cannot use, and
# the alternative was a third exception to the infra boundary.
#
# It exists mainly so CI can do it. Seven suites — the connector's scope
# report, both rule packs against the damaged tables, the redaction chain, and
# the three CLI commands end to end — skip without this database, and a CI that
# runs everything except the parts that touch a database is a CI that never
# checks the product.
#
# ## Two things that are not incidental
#
# **Postgres 18.** Pagila master uses `uuidv7()` and VIRTUAL columns; on 17 the
# schema will not load at all.
#
# **The upstream commit is PINNED.** `master` would make this reproducible only
# by luck: the fixture asserts exact counts, and several of them — how many
# tables the role can see, how many indexes exist — are counts of *base Pagila*
# rather than of the damage. A quiet upstream change would move those numbers
# and the failure would look like a regression in this repository.
set -euo pipefail

# devrimgunduz/pagila, 2026-08-06. Bump deliberately, and expect to re-check
# the counts in layer-a.regression.test.ts when you do.
PAGILA_SHA="${PAGILA_SHA:-eddcfc4513dab4239ee1acbdf52beb1f5fcf50ac}"
RAW="https://raw.githubusercontent.com/devrimgunduz/pagila/${PAGILA_SHA}"

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-55432}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-pagila}"
export PGHOST PGPORT PGUSER PGDATABASE

# How to reach psql. Default is the client on PATH, which is what a CI runner
# has. A machine with only Docker sets it to reach into the container:
#
#   PSQL="docker exec -i ledar-pagila psql" bash packages/test-fixtures/load-pagila.sh
#
# Every load below feeds SQL on stdin rather than with `-f`, precisely so both
# spellings work — `-f` would need the file to exist inside the container.
PSQL="${PSQL:-psql}"

ROOT="$(git rev-parse --show-toplevel)"
DAMAGE="$ROOT/packages/packs-layer-a/test/fixture-damage.sql"
[ -f "$DAMAGE" ] || { echo "no fixture-damage.sql at $DAMAGE" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "== 1/4  fetch Pagila @ ${PAGILA_SHA:0:7}"
curl -sSfL -o "$work/schema.sql" "$RAW/pagila-schema.sql"
curl -sSfL -o "$work/data.sql"   "$RAW/pagila-data.sql"
printf '   schema %s bytes · data %s bytes\n' \
  "$(wc -c < "$work/schema.sql" | tr -d ' ')" "$(wc -c < "$work/data.sql" | tr -d ' ')"

echo "== 2/4  load schema, then data"
$PSQL -v ON_ERROR_STOP=1 -q < "$work/schema.sql"
$PSQL -v ON_ERROR_STOP=1 -q < "$work/data.sql"

echo "== 3/4  plant the 14 deliberate faults"
$PSQL -v ON_ERROR_STOP=1 -q < "$DAMAGE"

# Fixture FIRST, grant AFTER. `GRANT ... ON ALL TABLES` covers the tables that
# exist when it runs, and base Pagila has ~75 of them.
#
# Skipping this step does not fail loudly. `has_table_privilege` filters every
# damaged table out of the scan, and the report comes back with 0 findings and
# full confidence — the exact product fault this repository exists to catch,
# reproduced by its own setup instructions. That is not hypothetical; the step
# used to be one sentence of prose with no SQL in it.
echo "== 4/4  read-only role"
$PSQL -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledar_reader') THEN
    CREATE ROLE "ledar_reader" LOGIN PASSWORD 'fixture_no_real_data';
  END IF;
END $$;

ALTER ROLE "ledar_reader"
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

GRANT CONNECT ON DATABASE "pagila" TO "ledar_reader";
GRANT USAGE ON SCHEMA "public" TO "ledar_reader";
GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "ledar_reader";
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT SELECT ON TABLES TO "ledar_reader";

ALTER ROLE "ledar_reader" SET default_transaction_read_only = on;
ALTER ROLE "ledar_reader" SET statement_timeout = '60s';
ALTER ROLE "ledar_reader" SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE "ledar_reader" SET lock_timeout = '3s';
SQL

echo
$PSQL -tAc "SELECT '   tables: ' || count(*) FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r'"
$PSQL -tAc "SELECT '   damaged_* tables: ' || count(*) FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'damaged\_%'"
$PSQL -tAc "SELECT '   readable by ledar_reader: ' || count(*) FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r'
             AND has_table_privilege('ledar_reader', c.oid, 'SELECT')"
echo
echo "   DSN: postgresql://ledar_reader:fixture_no_real_data@$PGHOST:$PGPORT/$PGDATABASE"
echo

#!/usr/bin/env bash
# Upgrade evidence for the web push migrations on a populated database.
#
#   scripts/web-push-evidence/upgrade.sh \
#     --sqlite-snapshot PATH --postgres-admin-dsn DSN --out DIR [--base v0.5.1]
#
# SQLite: a copy of an existing database (the snapshot itself is only read) is
# upgraded with the head binary's `migrate`. PostgreSQL: a fresh database on
# the given server is migrated and seeded by the base release, then upgraded by
# head, and dropped afterwards.
#
# For each engine the run records, before and after the upgrade: the row count
# and a SHA-256 of the full contents of user_notification_settings and
# channel_notification_settings, and the schema of both. It checks that
# user_push_subscriptions exists and is empty, and it replays Pushover
# recipient selection for every message with the base release before the
# upgrade and with head after it; the two digests must match. Only counts,
# schema, migration names, and digests are written to DIR.
set -euo pipefail

base="v0.5.1"
snapshot=""
admin_dsn=""
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sqlite-snapshot) snapshot="$2"; shift 2 ;;
    --postgres-admin-dsn) admin_dsn="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --base) base="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$snapshot" || -z "$admin_dsn" || -z "$out" ]]; then
  echo "usage: $0 --sqlite-snapshot PATH --postgres-admin-dsn DSN --out DIR [--base TAG]" >&2
  exit 2
fi
for tool in git go sqlite3 psql shasum; do
  command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 2; }
done

repo="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/clickclack-upgrade-evidence.XXXXXX")"
pg_db="clickclack_upgrade_$$"
pg_created=0
cleanup() {
  if [[ "$pg_created" == 1 ]]; then
    psql "$admin_dsn" -qAtc "DROP DATABASE IF EXISTS $pg_db" >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT
# The server's own settings must not leak into the runs below.
while IFS= read -r name; do unset "$name"; done < <(env | sed -n 's/^\(CLICKCLACK_[A-Z0-9_]*\)=.*/\1/p')

head_rev="$(git -C "$repo" rev-parse --short HEAD)"
base_rev="$(git -C "$repo" rev-parse --short "$base^{commit}")"
summary="$out/summary.txt"
failures=0
note() { printf '%s\n' "$*" | tee -a "$summary"; }
check() {
  if [[ "$2" == "$3" ]]; then note "  ok    $1"; else note "  FAIL  $1: $2 then $3"; failures=$((failures + 1)); fi
}
: >"$summary"
note "Web push upgrade evidence: $base ($base_rev) to head ($head_rev)"

for tree in base head; do
  rev="$base_rev"
  [[ "$tree" == head ]] && rev="$head_rev"
  mkdir -p "$work/$tree"
  git -C "$repo" archive "$rev" | tar -x -C "$work/$tree"
  mkdir -p "$work/$tree/apps/api/internal/upgradeevidence"
  cp "$repo/scripts/web-push-evidence/upgradeevidence/evidence_test.go" "$work/$tree/apps/api/internal/upgradeevidence/"
  (cd "$work/$tree" && go build -o "$work/clickclack-$tree" ./apps/api/cmd/clickclack)
done

evidence() {
  local tree="$1" db="$2" mode="$3" result="${4:-}"
  (cd "$work/$tree" && CLICKCLACK_EVIDENCE_DB="$db" CLICKCLACK_EVIDENCE_MODE="$mode" CLICKCLACK_EVIDENCE_OUT="$result" \
    go test -tags clickclack_upgrade_evidence ./apps/api/internal/upgradeevidence -run TestUpgradeEvidence -count=1 >/dev/null)
}

digest_of() { sed -n 's/.*"digest": "\([0-9a-f]*\)".*/\1/p' "$1"; }

sqlite_table() { sqlite3 -separator '|' "$1" "SELECT * FROM $2 ORDER BY 1, 2" | shasum -a 256 | cut -c1-64; }
sqlite_count() { sqlite3 "$1" "SELECT COUNT(*) FROM $2"; }
sqlite_schema() { sqlite3 "$1" ".schema $2" | shasum -a 256 | cut -c1-16; }
pg_table() { psql "$1" -qAtc "COPY (SELECT * FROM $2 ORDER BY 1, 2) TO STDOUT" | shasum -a 256 | cut -c1-64; }
pg_count() { psql "$1" -qAtc "SELECT COUNT(*) FROM $2"; }
pg_schema() {
  psql "$1" -qAtc "SELECT column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '$2' ORDER BY ordinal_position" | shasum -a 256 | cut -c1-16
}

compare_engine() {
  local engine="$1" db="$2" url="$3"
  local table rows hash schema
  : >"$work/$engine-before"
  for table in user_notification_settings channel_notification_settings; do
    printf '%s %s %s %s\n' "$table" "$("${engine}_count" "$db" "$table")" \
      "$("${engine}_table" "$db" "$table")" "$("${engine}_schema" "$db" "$table")" >>"$work/$engine-before"
  done
  evidence base "$url" digest "$work/$engine-base.json"
  if [[ "$engine" == sqlite ]]; then
    sqlite3 "$db" "SELECT name FROM schema_migrations ORDER BY name" >"$work/$engine-migrations-before"
    "$work/clickclack-head" migrate --db "$url" >/dev/null
    sqlite3 "$db" "SELECT name FROM schema_migrations ORDER BY name" >"$work/$engine-migrations-after"
  else
    psql "$db" -qAtc "SELECT name FROM schema_migrations ORDER BY name" >"$work/$engine-migrations-before"
    "$work/clickclack-head" migrate --db "$url" >/dev/null
    psql "$db" -qAtc "SELECT name FROM schema_migrations ORDER BY name" >"$work/$engine-migrations-after"
  fi
  note "  migrations applied by head: $(comm -13 "$work/$engine-migrations-before" "$work/$engine-migrations-after" | tr '\n' ' ')"
  while read -r table rows hash schema; do
    note "  $table: $rows rows, contents sha256 ${hash:0:16}, schema ${schema}"
    check "$table row count unchanged" "$rows" "$("${engine}_count" "$db" "$table")"
    check "$table contents unchanged" "$hash" "$("${engine}_table" "$db" "$table")"
    check "$table schema unchanged" "$schema" "$("${engine}_schema" "$db" "$table")"
  done <"$work/$engine-before"
  check "user_push_subscriptions exists and is empty" "0" "$("${engine}_count" "$db" user_push_subscriptions)"
  evidence head "$url" digest "$work/$engine-head.json"
  note "  $base recipient selection before upgrade: $(tr -d '\n ' <"$work/$engine-base.json")"
  note "  head recipient selection after upgrade:   $(tr -d '\n ' <"$work/$engine-head.json")"
  check "Pushover recipients identical before and after, web push off" "$(digest_of "$work/$engine-base.json")" "$(digest_of "$work/$engine-head.json")"
  if [[ "$engine" == sqlite ]]; then
    sqlite3 "$db" ".schema user_push_subscriptions" >"$out/$engine-user_push_subscriptions.schema"
  else
    psql "$db" -qAtc "SELECT column_name || ' ' || data_type || ' ' || is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'user_push_subscriptions' ORDER BY ordinal_position" >"$out/$engine-user_push_subscriptions.schema"
  fi
}

note ""
note "SQLite: copy of $(basename "$snapshot")"
mkdir -p "$work/sqlite"
cp "$snapshot" "$work/sqlite/clickclack.db"
# A checkpointed snapshot has an empty write-ahead log; one that is not needs
# its log and index copied with it.
if [[ -s "$snapshot-wal" ]]; then
  cp "$snapshot-wal" "$work/sqlite/clickclack.db-wal"
  if [[ -e "$snapshot-shm" ]]; then cp "$snapshot-shm" "$work/sqlite/clickclack.db-shm"; fi
fi
sqlite3 "$work/sqlite/clickclack.db" ".backup '$work/sqlite/clickclack.db.orig'"
note "  users: $(sqlite_count "$work/sqlite/clickclack.db" users), messages: $(sqlite_count "$work/sqlite/clickclack.db" messages), channels: $(sqlite_count "$work/sqlite/clickclack.db" channels)"
compare_engine sqlite "$work/sqlite/clickclack.db" "sqlite://$work/sqlite/clickclack.db"

note ""
note "SQLite: a second copy with Pushover turned on for every user by $base before the upgrade"
note "  (the snapshot's own users never set Pushover up, so the first pass selects nobody)"
mkdir -p "$work/sqlite-pushover"
cp "$work/sqlite/clickclack.db.orig" "$work/sqlite-pushover/clickclack.db"
evidence base "sqlite://$work/sqlite-pushover/clickclack.db" pushover
compare_engine sqlite "$work/sqlite-pushover/clickclack.db" "sqlite://$work/sqlite-pushover/clickclack.db"

note ""
note "PostgreSQL: fresh database migrated and seeded by $base"
psql "$admin_dsn" -qAtc "CREATE DATABASE $pg_db" >/dev/null
pg_created=1
pg_url="$(printf '%s' "$admin_dsn" | sed -E "s#(postgres(ql)?://[^/]*/)[^?]*#\\1$pg_db#")"
"$work/clickclack-base" migrate --db "$pg_url" >/dev/null
evidence base "$pg_url" seed
note "  users: $(pg_count "$pg_url" users), messages: $(pg_count "$pg_url" messages), channels: $(pg_count "$pg_url" channels)"
compare_engine pg "$pg_url" "$pg_url"

note ""
if [[ "$failures" == 0 ]]; then note "RESULT: PASS"; else note "RESULT: FAIL ($failures)"; fi
exit $((failures > 0))

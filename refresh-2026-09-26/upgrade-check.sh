#!/bin/zsh
# Populated-database upgrade from upstream v0.6.0 to the merge head, for the
# same-number migration pair. Usage: upgrade-check.sh sqlite|postgres
set -u
E=${0:A:h}; B=$E/bin; PORT=18693; base=http://127.0.0.1:$PORT
PGB=/opt/homebrew/opt/postgresql@17/bin
PGURL=postgres://postgres@127.0.0.1:55439
kind=$1
data=$(mktemp -d "$E/upgrade-$kind-XXXX")
dbargs=()
if [[ $kind == postgres ]]; then
  $PGB/psql "$PGURL/postgres" -qc "DROP DATABASE IF EXISTS roam_upgrade_ev" -qc "CREATE DATABASE roam_upgrade_ev" >/dev/null
  dbargs=(-db "$PGURL/roam_upgrade_ev?sslmode=disable")
fi
q() {
  if [[ $kind == postgres ]]; then $PGB/psql "$PGURL/roam_upgrade_ev" -Atc "$1"
  else sqlite3 "$data/clickclack.db" "$1"; fi
}
snapshot() {
  echo "schema_migrations rows = $(q 'SELECT count(*) FROM schema_migrations')"
  echo "migrations with prefix 0036, 0037, 0043, or 0044:"
  q "SELECT name FROM schema_migrations WHERE name LIKE '0036_%' OR name LIKE '0037_%' OR name LIKE '0043_%' OR name LIKE '0044_%' ORDER BY name" | sed 's/^/  /'
  for t in users workspaces channels messages; do echo "$t = $(q "SELECT count(*) FROM $t")"; done
  echo "user_push_subscriptions present = $(q "SELECT count(*) FROM $( [[ $kind == postgres ]] && echo information_schema.tables WHERE table_name || echo sqlite_master WHERE name )='user_push_subscriptions'")"
  echo "user_sidebar_channel_order present = $(q "SELECT count(*) FROM $( [[ $kind == postgres ]] && echo information_schema.tables WHERE table_name || echo sqlite_master WHERE name )='user_sidebar_channel_order'")"
}
start() { "$B/$1" serve --addr 127.0.0.1:$PORT --data "$data" --dev-bootstrap=true "${dbargs[@]}" > "$data/$1.log" 2>&1 & pid=$!
  for i in {1..100}; do curl -fs $base/healthz >/dev/null && break; sleep 0.2; done
  echo "healthz: $(curl -fs $base/healthz)"; }
stop() { kill $pid; wait $pid 2>/dev/null; echo stopped; }

echo "== $kind: 1. the PARENT binary (upstream 31d299ee, v0.6.0) creates and populates the database"
start clickclack-parent
ws=$(curl -fs -X POST $base/api/workspaces -H 'content-type: application/json' -d '{"name":"Upgrade evidence"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["workspace"]["id"])')
ch=$(curl -fs -X POST $base/api/workspaces/$ws/channels -H 'content-type: application/json' -d '{"name":"upgrade-ev"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["channel"]["id"])')
for n in 1 2 3; do curl -fs -X POST $base/api/channels/$ch/messages -H 'content-type: application/json' -d "{\"body\":\"message $n\"}" >/dev/null && echo "message $n created"; done
stop
echo; echo "== $kind: 2. BEFORE, as the parent left it"; snapshot
echo; echo "== $kind: 3. the HEAD binary (head 47c8c019, this PR merged with v0.6.0) starts against the same database"
start clickclack-head
echo "error lines in the head log: $(grep -ciE 'error|panic|fail' $data/clickclack-head.log)"
me=$(curl -fs -o /dev/null -w '%{http_code}' $base/api/me); echo "GET /api/me = $me"
patch=$(curl -fs -o /dev/null -w '%{http_code}' -X PATCH $base/api/me -H 'content-type: application/json' -d "{\"sidebar_preferences\":{\"channel_order\":{\"$ws\":[\"$ch\"]}}}"); echo "PATCH /api/me sidebar order = $patch"
echo "roamed order length for the workspace = $(curl -fs $base/api/me | python3 -c "import sys,json;print(len(json.load(sys.stdin)['user'].get('sidebar_preferences',{}).get('channel_order',{}).get('$ws',[])))")"
stop
echo; echo "== $kind: 4. AFTER"; snapshot
echo "user_sidebar_channel_order rows = $(q 'SELECT count(*) FROM user_sidebar_channel_order')"
if [[ $kind == postgres ]]; then $PGB/psql "$PGURL/postgres" -qc "DROP DATABASE roam_upgrade_ev" >/dev/null && echo "scratch database dropped"; fi

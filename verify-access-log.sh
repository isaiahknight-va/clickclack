#!/bin/zsh
# Real-behavior proof for the access-log finding.
# Usage: verify-access-log.sh <label> <binary> <port> <seconds> [extra serve args...]
# Starts the binary with --dev-bootstrap on a temp data dir, logs to a fresh
# file, bootstraps a session, runs TWO pollers on /api/realtime/events every
# 2 s (the documented bot pull loop, same cadence as our production bridges)
# for <seconds>, fires one request that 404s, then reports line counts.
set -u
label=$1; binary=$2; port=$3; seconds=$4; shift 4
data=$(mktemp -d "${TMPDIR:-/tmp}/cc-accesslog-$label-XXXX")
logf="$data/server.log"
"$binary" serve --addr "127.0.0.1:$port" --data "$data" --dev-bootstrap=true "$@" >"$logf" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null' EXIT
for i in {1..100}; do curl -fs "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break; sleep 0.2; done
jar="$data/cookies.txt"
# dev-bootstrap: first /app visit signs in the bootstrap owner (session cookie)
curl -s -c "$jar" -b "$jar" -o /dev/null "http://127.0.0.1:$port/app"
ws=$(curl -s -b "$jar" "http://127.0.0.1:$port/api/workspaces" | python3 -c 'import sys,json; print(json.load(sys.stdin)["workspaces"][0]["id"])')
poll() { local end=$((SECONDS+seconds)); while (( SECONDS < end )); do curl -s -b "$jar" -o /dev/null "http://127.0.0.1:$port/api/realtime/events?workspace_id=$ws&limit=1&include_tail=true"; sleep 2; done; }
poll & p1=$!
poll & p2=$!
wait $p1 $p2
curl -s -b "$jar" -o /dev/null -w '' "http://127.0.0.1:$port/api/nope"   # one 404
sleep 0.5
kill $pid; wait $pid 2>/dev/null; trap - EXIT
total=$(grep -c 'route=' "$logf"); ok=$(grep -c 'status=200' "$logf"); ev=$(grep -c 'route="/api/realtime/events"' "$logf"); err=$(grep -c -E 'status=[45][0-9][0-9]' "$logf")
echo "[$label] serve args: --dev-bootstrap=true $* | pollers: 2 x every 2 s for ${seconds}s"
echo "[$label] access-log lines: total=$total status=200: $ok events-route: $ev non-2xx: $err"
echo "[$label] non-2xx lines kept:"; grep -E 'status=[45][0-9][0-9]' "$logf" | sed 's/^/    /'
echo "[$label] projected at this cadence: $(( ok * 86400 / seconds )) status=200 lines/day"
echo "[$label] log file: $(du -h "$logf" | cut -f1) for ${seconds}s"

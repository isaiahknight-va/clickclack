#!/bin/zsh
# Starts each throwaway server in turn, runs proof.mjs headless against it, stops it.
S=${S:-$PWD/work}
OUT=$S/proof-results
mkdir -p $OUT
port=18160
for build in before c1 after; do
  rm -rf $S/data-proof-$build
  $S/clickclack-$build serve --addr 127.0.0.1:$port --data $S/data-proof-$build --dev-bootstrap=true > $OUT/server-$build.log 2>&1 &
  pid=$!
  for i in {1..50}; do curl -s -o /dev/null http://127.0.0.1:$port/ && break; sleep 0.2; done
  node $S/proof.mjs $build http://127.0.0.1:$port $OUT || echo "proof failed for $build"
  kill $pid; wait $pid 2>/dev/null
  port=$((port + 1))
done

#!/bin/sh
# Runs every suite. Each one reads the userscript directly; nothing is generated.
#
# The timeout lives here rather than in the suites: test/env.js carries an
# in-process watchdog, but only four of the nine suites load it, and the two
# most likely to hang -- ocr_perf_test (set cover over the whole dictionary)
# and oracle_server_test (spawns processes, binds sockets) -- are not among
# them. Here it covers all nine and names the one that hung.
set -e
cd "$(dirname "$0")"

SECS=$(( ${TEST_WATCHDOG_MS:-180000} / 1000 ))
if command -v timeout >/dev/null 2>&1; then RUN="timeout ${SECS}s"; else RUN=""; fi

for t in ocr_test.js ocr_perf_test.js frame_test.js integration_test.js loops_test.js oracle_test.js oracle_server_test.js config_migration_test.js debug_gate_test.js; do
  echo "=== $t ==="
  $RUN node "$t" || {
    status=$?
    [ "$status" = 124 ] && echo "TIMEOUT: $t still running after ${SECS}s — giving up"
    exit "$status"
  }
done

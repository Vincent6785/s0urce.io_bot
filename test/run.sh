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

# Integer division turns anything under 1000 into `timeout 0s`, which GNU
# timeout documents as no timeout at all -- so a value meant to tighten the
# guard would silently remove it, and so would a typo. Reject non-numbers and
# floor the result at one second.
MS=${TEST_WATCHDOG_MS:-180000}
case $MS in
  ''|*[!0-9]*)
    echo "TEST_WATCHDOG_MS must be a whole number of milliseconds (got '$MS')" >&2
    exit 2
    ;;
esac
SECS=$(( MS / 1000 ))
if [ "$SECS" -lt 1 ]; then SECS=1; fi

# -k matters: plain timeout only sends TERM, so a suite wedged in a native call
# would never die -- the exact failure this guard exists to stop.
if command -v timeout >/dev/null 2>&1; then RUN="timeout -k 10s ${SECS}s"; else RUN=""; fi

for t in ocr_test.js ocr_perf_test.js frame_test.js integration_test.js loops_test.js oracle_test.js oracle_server_test.js config_migration_test.js debug_gate_test.js; do
  echo "=== $t ==="
  $RUN node "$t" || {
    status=$?
    # 124 is timeout's own code; 137 is SIGKILL, which is what -k produces when
    # TERM was ignored. Both mean the same thing to a reader.
    case $status in
      124|137) echo "TIMEOUT: $t still running after ${SECS}s — giving up" >&2 ;;
    esac
    exit "$status"
  }
done

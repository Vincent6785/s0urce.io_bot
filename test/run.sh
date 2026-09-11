#!/bin/sh
# Runs every suite. Each one reads the userscript directly; nothing is generated.
set -e
cd "$(dirname "$0")"
for t in ocr_test.js ocr_perf_test.js frame_test.js integration_test.js loops_test.js oracle_test.js oracle_server_test.js config_migration_test.js debug_gate_test.js; do
  echo "=== $t ==="
  node "$t"
done

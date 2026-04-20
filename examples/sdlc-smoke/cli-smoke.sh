#!/usr/bin/env bash
##
## CLI Pipeline Smoke Test
## Tests all pipeline CLI commands work correctly.
##
## Usage:
##   bash examples/sdlc-smoke/cli-smoke.sh
##
## What this proves:
##   C1: pipeline show (defaults)
##   C2: pipeline config init
##   C3: pipeline config on/off with aliases
##   C4: pipeline config set with aliases
##   C5: pipeline show (reflects config)
##   C6: pipeline config reset
##   C7: metrics (no data)
##   C8: --help includes pipeline commands
##   C9: --version works
##

set -euo pipefail

CLI="node packages/cli/dist/bin.js"
PASS=0
FAIL=0
TOTAL=0
CONFIG="agentweave.yaml"

# Colors
GREEN="\033[32m"
RED="\033[31m"
CYAN="\033[36m"
DIM="\033[2m"
BOLD="\033[1m"
RESET="\033[0m"
LINE="────────────────────────────────────────────────────────────"

check() {
  local id=$1
  local name=$2
  local condition=$3
  TOTAL=$((TOTAL + 1))
  if [ "$condition" = "true" ]; then
    echo -e "  ${GREEN}✓ ${id}${RESET}  ${name}"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗ ${id}${RESET}  ${name}"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo -e "  ${CYAN}${BOLD}AgentWeave CLI Pipeline — Smoke Test${RESET}"
echo -e "  ${DIM}${LINE}${RESET}"
echo ""

# Cleanup any existing config
rm -f "$CONFIG"

# ── C1: pipeline show (defaults) ──────────────────────────────

echo -e "  ${CYAN}C1: pipeline show (defaults)${RESET}"
OUTPUT=$($CLI pipeline show 2>&1)
check "C1a" "Shows '8-Step' header" "$(echo "$OUTPUT" | grep -q '8-Step' && echo true || echo false)"
check "C1b" "Shows 'defaults' source" "$(echo "$OUTPUT" | grep -q 'defaults' && echo true || echo false)"
check "C1c" "Shows all 8 steps" "$(echo "$OUTPUT" | grep -c 'Step' | awk '{print ($1 >= 8) ? "true" : "false"}')"

# ── C2: pipeline config init ──────────────────────────────────

echo ""
echo -e "  ${CYAN}C2: pipeline config init${RESET}"
$CLI pipeline config init > /dev/null 2>&1
check "C2a" "Creates agentweave.yaml" "$(test -f "$CONFIG" && echo true || echo false)"
check "C2b" "File is valid JSON" "$(python -c 'import json; json.load(open("agentweave.yaml"))' 2>/dev/null && echo true || node -e 'try{JSON.parse(require("fs").readFileSync("agentweave.yaml","utf8"));console.log("true")}catch{console.log("false")}')"

# ── C3: pipeline config on/off ────────────────────────────────

echo ""
echo -e "  ${CYAN}C3: config on/off with aliases${RESET}"
$CLI pipeline config off all > /dev/null 2>&1
OUTPUT=$($CLI pipeline config 2>&1)
OFF_COUNT=$(echo "$OUTPUT" | grep -c 'OFF' || true)
check "C3a" "config off all → all modules OFF" "$([ "$OFF_COUNT" -ge 8 ] && echo true || echo false)"

$CLI pipeline config on qa retry exec > /dev/null 2>&1
OUTPUT=$($CLI pipeline config 2>&1)
ON_COUNT=$(echo "$OUTPUT" | grep -c 'ON ' || true)
check "C3b" "config on qa retry exec → 3 modules ON" "$([ "$ON_COUNT" -ge 3 ] && echo true || echo false)"

# ── C4: pipeline config set ───────────────────────────────────

echo ""
echo -e "  ${CYAN}C4: config set with aliases${RESET}"
SET_OUTPUT=$($CLI pipeline config set qa.checks "pnpm test:unit,eslint src/" 2>&1)
check "C4a" "set qa.checks succeeds" "$(echo "$SET_OUTPUT" | grep -q 'Set' && echo true || echo false)"

SET_OUTPUT=$($CLI pipeline config set retry.maxRetries 5 2>&1)
check "C4b" "set retry.maxRetries succeeds" "$(echo "$SET_OUTPUT" | grep -q 'Set' && echo true || echo false)"

SET_OUTPUT=$($CLI pipeline config set execution.agent claude 2>&1)
check "C4c" "set execution.agent succeeds" "$(echo "$SET_OUTPUT" | grep -q 'Set' && echo true || echo false)"

# ── C5: pipeline show (reflects config) ───────────────────────

echo ""
echo -e "  ${CYAN}C5: pipeline show reflects config${RESET}"
OUTPUT=$($CLI pipeline show 2>&1)
check "C5a" "Shows agentweave.yaml source" "$(echo "$OUTPUT" | grep -q 'agentweave.yaml' && echo true || echo false)"
check "C5b" "Shows agent: claude" "$(echo "$OUTPUT" | grep -q 'claude' && echo true || echo false)"
check "C5c" "Shows QA checks" "$(echo "$OUTPUT" | grep -q 'pnpm test:unit' && echo true || echo false)"
check "C5d" "Shows retry max: 5" "$(echo "$OUTPUT" | grep -q 'max: 5' && echo true || echo false)"

# ── C6: pipeline config reset ─────────────────────────────────

echo ""
echo -e "  ${CYAN}C6: config reset${RESET}"
$CLI pipeline config reset > /dev/null 2>&1
OUTPUT=$($CLI pipeline config 2>&1)
ON_COUNT=$(echo "$OUTPUT" | grep -c 'ON ' || true)
check "C6" "Reset restores defaults (7 ON, 1 OFF)" "$([ "$ON_COUNT" -ge 7 ] && echo true || echo false)"

# ── C7: metrics (no data) ─────────────────────────────────────

echo ""
echo -e "  ${CYAN}C7: metrics command${RESET}"
rm -rf .agentweave/metrics 2>/dev/null || true
OUTPUT=$($CLI metrics 2>&1)
check "C7" "metrics with no data shows helpful message" "$(echo "$OUTPUT" | grep -qi 'no.*metric\|run.*task\|not found' && echo true || echo false)"

# ── C8: help includes pipeline ────────────────────────────────

echo ""
echo -e "  ${CYAN}C8-C9: Global commands${RESET}"
HELP=$($CLI --help 2>&1)
check "C8a" "Help includes 'pipeline run'" "$(echo "$HELP" | grep -q 'pipeline run' && echo true || echo false)"
check "C8b" "Help includes 'pipeline show'" "$(echo "$HELP" | grep -q 'pipeline show' && echo true || echo false)"
check "C8c" "Help includes 'pipeline config'" "$(echo "$HELP" | grep -q 'pipeline config' && echo true || echo false)"

# ── C9: version ───────────────────────────────────────────────

VERSION=$($CLI --version 2>&1)
check "C9" "version returns 1.1.0" "$(echo "$VERSION" | grep -q '1.1.0' && echo true || echo false)"

# ── Cleanup ───────────────────────────────────────────────────

rm -f "$CONFIG"

# ── Summary ───────────────────────────────────────────────────

echo ""
echo -e "  ${DIM}${LINE}${RESET}"
if [ "$FAIL" -eq 0 ]; then
  echo -e "  ${GREEN}${BOLD}ALL PASS${RESET}  ${GREEN}${PASS}${RESET}/${TOTAL} checks passed"
else
  echo -e "  ${RED}${BOLD}FAILURES${RESET}  ${GREEN}${PASS}${RESET}/${TOTAL} passed, ${RED}${FAIL}${RESET} failed"
fi
echo -e "  ${DIM}${LINE}${RESET}"
echo ""

exit $FAIL

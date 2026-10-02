#!/usr/bin/env bash
# Runs the browser-guard test suite against a live Chrome on the CDP port.
#
# Requires: bun, and Chrome already running via bin/chrome-cdp-profile.
# Optional: a local site on $TARGET so the tabs carry real URLs rather than
# about:blank, which the guard treats as inert.
#
#   ./test/run.sh
#
# Every round restarts the browser for a known-clean slate, then asserts both the
# guard's decision AND the resulting browser state — a run only passes if the
# right call was made *and* no tab was destroyed.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
LAUNCHER="$ROOT/bin/chrome-cdp-profile"
SYNC="${GUARD_TEST_SYNC:-$HOME/tmp/race}"
PORT="${PLAYWRIGHT_MCP_CDP_PORT:-9222}"
TARGET="${GUARD_TEST_TARGET:-http://127.0.0.1:8000}"

pass=0
fail=0
LOGDIR="$(mktemp -d)"

check() { # check <description> <0|1>
  if [ "$2" = "1" ]; then
    printf '  PASS  %s\n' "$1"
    pass=$((pass + 1))
  else
    printf '  FAIL  %s\n' "$1"
    fail=$((fail + 1))
  fi
}

reset_browser() {
  "$LAUNCHER" --stop >/dev/null 2>&1
  sleep 1
  "$LAUNCHER" >/dev/null 2>&1
}

tab_count() {
  curl -sf -m 3 "http://127.0.0.1:$PORT/json/list" | grep -c '"type": *"page"'
}

# Runs one harness in the background and releases it once it has claimed its tab.
# Echoes the harness output.
run_harness() { # run_harness <logname> <sessionID> <url>
  local log="$LOGDIR/$1.log" sid="$2" url="$3"
  rm -rf "$SYNC"; mkdir -p "$SYNC"
  bun "$HERE/race-harness.ts" "$sid" "$url" >"$log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 60); do
    [ -f "$SYNC/$sid.opened" ] && break
    sleep 0.25
  done
  touch "$SYNC/GO"
  wait "$pid"
  cat "$log"
}

if ! curl -sf -m 3 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "no Chrome on $PORT — start it with $LAUNCHER" >&2
  exit 1
fi
if ! curl -sf -m 3 -o /dev/null "$TARGET" 2>/dev/null; then
  echo "note: $TARGET is not serving; tabs will fall back to about:blank (inert)" >&2
fi

echo "== single instance: closes its own tab =="
reset_browser
solo=$(run_harness solo ses_SOLO "$TARGET/pricing.html")
echo "$solo" | grep "RESULT=" | sed 's/^/  /'
baseline=$(tab_count)
check "close of own tab is allowed when alone" \
  "$(echo "$solo" | grep -q 'RESULT=ALLOWED' && echo 1 || echo 0)"
check "browser still has a tab afterwards" \
  "$([ "$(tab_count)" -ge 1 ] && echo 1 || echo 0)"
echo "  (tabs $baseline -> $(tab_count))"

echo
echo "== concurrent instances: 3-way race =="
for round in 1 2; do
  reset_browser
  rm -rf "$SYNC"; mkdir -p "$SYNC"
  baseline=$(tab_count)

  bun "$HERE/race-harness.ts" ses_A "$TARGET/pricing.html" >"$LOGDIR/A.log" 2>&1 &
  bun "$HERE/race-harness.ts" ses_B "$TARGET/contact.html" >"$LOGDIR/B.log" 2>&1 &
  bun "$HERE/race-harness.ts" ses_C "$TARGET/about.html"   >"$LOGDIR/C.log" 2>&1 &
  wait

  for _ in $(seq 1 60); do
    [ -f "$SYNC/ses_A.opened" ] && [ -f "$SYNC/ses_B.opened" ] && [ -f "$SYNC/ses_C.opened" ] && break
    sleep 0.25
  done
  touch "$SYNC/GO"
  wait
  sleep 1

  denied=$(grep -l "RESULT=DENIED" "$LOGDIR"/A.log "$LOGDIR"/B.log "$LOGDIR"/C.log 2>/dev/null | wc -l | tr -d ' ')
  survived=$(tab_count)
  echo "  round $round: denied=$denied/3   tabs $baseline -> $survived"

  check "round $round: every instance denied" "$([ "$denied" = "3" ] && echo 1 || echo 0)"
  check "round $round: no tab destroyed"      "$([ "$survived" -ge "$baseline" ] && echo 1 || echo 0)"
done

echo
echo "== TTL expiry =="
reset_browser
ttl_out=$(BROWSER_GUARD_TTL_MS=2000 bun "$HERE/ttl-harness.ts" ses_TTL "$TARGET/pricing.html" 2>/dev/null)
echo "$ttl_out" | sed 's/^/  /'
check "fresh claim allowed"  "$(echo "$ttl_out" | grep -q 'ALLOWED' && echo 1 || echo 0)"
check "expired claim denied" "$([ "$(echo "$ttl_out" | grep -c 'DENIED')" = "1" ] && echo 1 || echo 0)"

rm -rf "$SYNC" "$LOGDIR"
reset_browser

echo
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ]
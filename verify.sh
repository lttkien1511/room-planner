#!/usr/bin/env bash
# Smoke test of the running stack (read-only: never writes projects). Usage: ./verify.sh [base-url]
set -uo pipefail
BASE="${1:-http://127.0.0.1:5080}"
pass=0; fail=0
ok()  { echo "  PASS  $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }
chk() { # chk "<name>" "<expected substring>" curl-args...
  local name="$1" want="$2"; shift 2
  out=$(curl -fsS -m 10 "$@" 2>&1) && [[ "$out" == *"$want"* ]] && ok "$name" || bad "$name  ($(echo "$out" | head -c 120))"
}

echo "== Room Planner @ $BASE"
chk "nginx /healthz"                 "ok"                 "$BASE/healthz"
chk "index.html is served"           "Room Planner"       "$BASE/"
chk "three.js bundle is served"      "export{"            "$BASE/vendor/three.bundle.js" -r -1500   # the export list is at the end of the file
mime=$(curl -fsSI -m 10 "$BASE/js/main.js" 2>&1 | tr -d '\r' | grep -i '^content-type:')
[[ "$mime" == *javascript* ]] && ok "ES modules are served as JavaScript ($mime)" || bad "js MIME type wrong: $mime"
chk "API health (storage writable)"  '"ok": true'         "$BASE/api/health"
chk "API lists projects"             "["                  "$BASE/api/projects"
chk "API lists custom items"         "["                  "$BASE/api/custom-items"
hdr=$(curl -fsSI -m 10 "$BASE/" 2>&1)
[[ "$hdr" == *"Content-Security-Policy"* ]] && ok "CSP header present on /" || bad "CSP header missing on /"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X PUT -H 'Content-Type: application/json' -d '{}' "$BASE/api/projects/p-verify-noheader")
[ "$code" = "403" ] && ok "PUT without X-Requested-With is rejected (403)" || bad "CSRF guard: expected 403, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$BASE/api/projects/..%2F..%2Fetc%2Fpasswd")
[ "$code" = "404" ] && ok "path traversal id is rejected (404)" || bad "path traversal: expected 404, got $code"

echo "== $pass passed, $fail failed"
[ "$fail" -eq 0 ]

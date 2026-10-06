#!/usr/bin/env bash
# Add  room.kienhomeserver.lab -> 192.168.50.10  to the BIND zone on the Bastion (192.168.50.5).
# Run ON THE BASTION with sudo (copy this file over first):
#   scp add-dns.sh kienbastion@192.168.50.5:~ && ssh -t kienbastion@192.168.50.5 'sudo bash add-dns.sh'
# Backs up the zone, validates it with named-checkzone and rolls back on any error.
set -euo pipefail
ZONE=kienhomeserver.lab
FILE=/etc/bind/db.kienhomeserver.lab
NAME=room
IP=192.168.50.10

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo bash $0"; exit 1; }
[ -f "$FILE" ] || { echo "ERROR: $FILE not found - is this the Bastion?"; exit 1; }

if grep -Eq "^${NAME}[[:space:]].*[[:space:]]A[[:space:]]+${IP}" "$FILE"; then
  echo "Record already present:"; grep -E "^${NAME}[[:space:]]" "$FILE"; exit 0
fi
if grep -Eq "^${NAME}[[:space:]]" "$FILE"; then
  echo "ERROR: a different '${NAME}' record already exists:"; grep -E "^${NAME}[[:space:]]" "$FILE"; exit 1
fi

BAK="$FILE.bak-$(date +%Y%m%d-%H%M%S)"
cp -a "$FILE" "$BAK"
rollback() { echo "Rolling back to $BAK"; cp -a "$BAK" "$FILE"; }
trap 'rollback' ERR

# append the record, then bump the SOA serial (max(old+1, YYYYMMDD01))
printf '%s\tIN\tA\t%s\n' "$NAME" "$IP" >> "$FILE"
python3 - "$FILE" <<'PY'
import re, sys, time
p = sys.argv[1]
t = open(p).read()
m = re.search(r'(SOA[^(]*\(\s*)(\d+)', t, re.S) or re.search(r'(SOA\s+\S+\s+\S+\s+)(\d+)', t)
if not m:
    sys.exit("could not find the SOA serial")
old = int(m.group(2))
new = max(old + 1, int(time.strftime('%Y%m%d') + '01'))
open(p, 'w').write(t[:m.start(2)] + str(new) + t[m.end(2):])
print(f"SOA serial {old} -> {new}")
PY
named-checkzone "$ZONE" "$FILE"
rndc reload "$ZONE"
trap - ERR
sleep 1
echo "Answer from the local BIND:"; dig +short @127.0.0.1 "${NAME}.${ZONE}" A
echo "Done. Backup kept at $BAK"

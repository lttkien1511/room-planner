#!/usr/bin/env bash
# Move project storage from ./data (local disk) to the OMV share and restart the API. No sudo.
# Needs: sudo bash setup-mount.sh done first. Existing projects are copied, ./data is kept as a backup.
set -euo pipefail
cd "$(dirname "$0")"
MNT=/mnt/omv/room-planner

ls "$MNT" >/dev/null 2>&1 || true
[ "$(findmnt -T "$MNT" -no FSTYPE 2>/dev/null)" = "nfs" ] || { echo "ERROR: $MNT is not mounted. Run: sudo bash setup-mount.sh"; exit 1; }
touch "$MNT/.write-test" && rm -f "$MNT/.write-test" || { echo "ERROR: $MNT is not writable"; exit 1; }

[ -f .env ] || cp .env.example .env
if [ -d data ] && [ -n "$(ls -A data 2>/dev/null)" ]; then
  echo "Copying existing projects to $MNT ..."
  cp -r data/. "$MNT"/   # no -a: an all_squash NFS export refuses to set owner/times on its root
fi
if grep -q '^DATA_DIR=' .env; then sed -i "s|^DATA_DIR=.*|DATA_DIR=$MNT|" .env; else echo "DATA_DIR=$MNT" >> .env; fi
echo "DATA_DIR is now $MNT"
./deploy.sh

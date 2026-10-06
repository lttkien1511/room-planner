#!/usr/bin/env bash
# Start / update Room Planner. Run on the Homeserver as the normal user (no sudo needed):
#   cd /home/room-planner && ./deploy.sh
# Safe to re-run: web/ and api/ are bind-mounted, so code changes only need this to restart the API.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { cp .env.example .env; echo "Created .env from .env.example"; }
set -a; . ./.env; set +a
DATA_DIR="${DATA_DIR:-./data}"

# Never let the API silently write to the local disk when it is supposed to use the OMV share.
case "$DATA_DIR" in
  /mnt/omv/*)
    ls "$DATA_DIR" >/dev/null 2>&1 || true            # triggers the systemd automount
    fs=$(findmnt -T "$DATA_DIR" -no FSTYPE 2>/dev/null || true)
    case "$fs" in nfs|nfs4) ;; *)
      echo "ERROR: DATA_DIR=$DATA_DIR is not an NFS mount (found: '${fs:-none}'). Run: sudo bash setup-mount.sh"
      exit 1 ;;
    esac
    [ -w "$DATA_DIR" ] || { echo "ERROR: $DATA_DIR is not writable for $(id -un). Check the OMV export permissions."; exit 1; }
    ;;
  *) mkdir -p "$DATA_DIR" ;;
esac

docker compose pull --quiet
docker compose up -d --remove-orphans

echo "Waiting for containers to become healthy ..."
for _ in $(seq 1 30); do
  bad=$(docker compose ps --format '{{.Name}} {{.Health}}' | grep -v ' healthy$' || true)
  [ -z "$bad" ] && break
  sleep 2
done
docker compose ps
./verify.sh

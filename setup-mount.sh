#!/usr/bin/env bash
# Mount the OMV export /export/room-planner at /mnt/omv/room-planner (same pattern as sync-in / actual-budget).
# Run ONCE with sudo on the Homeserver, AFTER the NFS share exists on OMV (see README "OMV"):
#   sudo bash /home/room-planner/setup-mount.sh
set -euo pipefail
OMV=192.168.50.15
EXPORT=/export/room-planner
MNT=/mnt/omv/room-planner
FSTAB_LINE="$OMV:$EXPORT $MNT nfs defaults,_netdev,nofail,x-systemd.automount,x-systemd.mount-timeout=30 0 0"

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo bash $0"; exit 1; }

echo "[1/5] Checking that OMV exports $EXPORT ..."
if ! showmount -e "$OMV" | awk 'NR>1{print $1}' | grep -qx "$EXPORT"; then
  echo "ERROR: $OMV does not export $EXPORT yet. Create the shared folder + NFS share in OMV and click Apply first."
  showmount -e "$OMV" || true
  exit 1
fi

echo "[2/5] Creating mount point $MNT ..."
mkdir -p "$MNT"

echo "[3/5] Adding fstab entry (same options as the other OMV mounts) ..."
if grep -qF " $MNT " /etc/fstab; then
  echo "  already present, skipping"
else
  cp /etc/fstab "/etc/fstab.bak-$(date +%Y%m%d-%H%M%S)"
  echo "$FSTAB_LINE" >> /etc/fstab
fi
systemctl daemon-reload

echo "[4/5] Mounting ..."
mount "$MNT" 2>/dev/null || true
ls -la "$MNT"
findmnt -T "$MNT" -o TARGET,SOURCE,FSTYPE,OPTIONS
findmnt -T "$MNT" -no FSTYPE | grep -qx nfs || { echo "ERROR: $MNT is not an NFS mount, refusing to continue"; exit 1; }

echo "[5/5] Write test (root is squashed to the export's anonuid) ..."
touch "$MNT/.write-test"
stat -c '  created as %U(%u):%G(%g)  %n' "$MNT/.write-test"
rm -f "$MNT/.write-test"
echo "OK - $MNT is mounted and writable. Next (no sudo): cd /home/room-planner && ./use-omv.sh"

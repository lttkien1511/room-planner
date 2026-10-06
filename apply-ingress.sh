#!/usr/bin/env bash
# Create the k3s Ingress + self-signed cert for https://room.kienhomeserver.lab (no sudo).
set -euo pipefail
cd "$(dirname "$0")"
export KUBECONFIG="${KUBECONFIG:-/home/kien/.kube/k3s.yaml}"   # the user-readable copy (the /etc/rancher one needs root)
kubectl apply -f k8s-ingress.yaml
echo "Waiting for the certificate ..."
kubectl -n room-planner wait --for=condition=Ready certificate/room-planner-tls --timeout=90s
kubectl -n room-planner get ingress,certificate
echo
echo "Still needed once, on the Bastion (sudo): bash add-dns.sh   (DNS record room.kienhomeserver.lab -> 192.168.50.10)"

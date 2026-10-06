#!/usr/bin/env bash
# Create the k3s Ingress + self-signed cert for https://dev-room.kienhomeserver.lab (no sudo).
set -euo pipefail
cd "$(dirname "$0")"
KUBECONFIG=/home/kien/.kube/k3s.yaml kubectl apply -f k8s-ingress-dev.yaml
echo "Still needed once, on the Bastion (sudo): add DNS record dev-room.kienhomeserver.lab -> 192.168.50.10"

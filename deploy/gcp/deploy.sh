#!/usr/bin/env bash
#
# Deploy the whole stack to a single Compute Engine VM.
#
#   deploy/gcp/deploy.sh                # create (or update) and deploy
#   deploy/gcp/deploy.sh --destroy      # tear it all down
#
# Idempotent: re-running syncs the code and rebuilds the containers.
# Configure with env vars:
#
#   GCP_PROJECT      required unless `gcloud config get project` is set
#   GCP_ZONE         default us-central1-a
#   VM_NAME          default extraction-service
#   MACHINE_TYPE     default e2-standard-4 (16 GB; mistral needs ~6 GB)
#   ALLOW_CIDR       who may reach port 80. Default: your current public
#                    IP only. There is no auth on any endpoint, so do not
#                    set this to 0.0.0.0/0 without putting auth in front.
#
# CPU inference on e2-standard-4 takes ~1-3 minutes per invoice. For a
# GPU, see the note at the bottom of this file.

set -euo pipefail
cd "$(dirname "$0")/../.."

PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${GCP_ZONE:-us-central1-a}"
VM="${VM_NAME:-extraction-service}"
MACHINE="${MACHINE_TYPE:-e2-standard-4}"
TAG="extraction-web"
REMOTE_DIR="/opt/extraction"

if [ -z "$PROJECT" ]; then
  echo "Set GCP_PROJECT or run: gcloud config set project <id>" >&2
  exit 1
fi

gc() { gcloud --project "$PROJECT" "$@"; }

# --- destroy ---------------------------------------------------------------

if [ "${1:-}" = "--destroy" ]; then
  gc compute instances delete "$VM" --zone "$ZONE" --quiet || true
  gc compute firewall-rules delete "allow-$TAG" --quiet || true
  echo "Destroyed."
  exit 0
fi

# --- infra -----------------------------------------------------------------

gc services enable compute.googleapis.com >/dev/null

ALLOW="${ALLOW_CIDR:-$(curl -sf https://api.ipify.org)/32}"
if gc compute firewall-rules describe "allow-$TAG" >/dev/null 2>&1; then
  gc compute firewall-rules update "allow-$TAG" --source-ranges "$ALLOW" >/dev/null
else
  gc compute firewall-rules create "allow-$TAG" \
    --allow tcp:80 --target-tags "$TAG" --source-ranges "$ALLOW" >/dev/null
fi
echo "Port 80 open to: $ALLOW"

if ! gc compute instances describe "$VM" --zone "$ZONE" >/dev/null 2>&1; then
  echo "Creating $VM ($MACHINE) in $ZONE..."
  gc compute instances create "$VM" \
    --zone "$ZONE" \
    --machine-type "$MACHINE" \
    --image-family debian-12 --image-project debian-cloud \
    --boot-disk-size 50GB \
    --tags "$TAG" \
    --metadata startup-script='#!/bin/bash
      set -e
      if ! command -v docker >/dev/null; then
        curl -fsSL https://get.docker.com | sh
      fi
      mkdir -p '"$REMOTE_DIR"'
      chown "$(id -un 1000 2>/dev/null || echo root)" '"$REMOTE_DIR"' || true
    '
  echo "Waiting for SSH and Docker install..."
  for _ in $(seq 1 40); do
    if gc compute ssh "$VM" --zone "$ZONE" --quiet \
         --command "command -v docker >/dev/null" 2>/dev/null; then
      break
    fi
    sleep 10
  done
fi

# --- ship the code ---------------------------------------------------------

echo "Syncing source..."
tar czf - \
  --exclude node_modules --exclude .venv --exclude dist --exclude .git \
  --exclude '*.db' --exclude uploads --exclude __pycache__ --exclude e2e \
  --exclude .pytest_cache --exclude .DS_Store \
  . | gc compute ssh "$VM" --zone "$ZONE" --quiet --command \
  "sudo mkdir -p $REMOTE_DIR && sudo chown \$(id -u) $REMOTE_DIR && tar xzf - -C $REMOTE_DIR"

# --- run -------------------------------------------------------------------

echo "Building and starting containers (first run pulls mistral, ~4 GB)..."
gc compute ssh "$VM" --zone "$ZONE" --quiet --command \
  "cd $REMOTE_DIR && sudo docker compose up -d --build --remove-orphans"

IP=$(gc compute instances describe "$VM" --zone "$ZONE" \
  --format 'get(networkInterfaces[0].accessConfigs[0].natIP)')

echo ""
echo "  Review UI    http://$IP"
echo "  API docs     http://$IP/api/docs"
echo "  Webhooks     http://$IP/webhooks/deliveries"
echo ""
echo "Logs:   gcloud compute ssh $VM --zone $ZONE -- sudo docker compose -f $REMOTE_DIR/docker-compose.yml logs -f"
echo "Status: gcloud compute ssh $VM --zone $ZONE -- sudo docker compose -f $REMOTE_DIR/docker-compose.yml ps"

# GPU note: for ~10x faster extraction, create the VM with
#   MACHINE_TYPE=n1-standard-4 and add
#   --accelerator type=nvidia-tesla-t4,count=1 --maintenance-policy TERMINATE
# then install the NVIDIA driver + nvidia-container-toolkit on the host and
# add `deploy.resources.reservations.devices` to the ollama service in
# docker-compose.yml. Requires GPU quota in the project.

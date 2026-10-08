#!/usr/bin/env bash
# Print (default) or run (--run) the gcloud commands that create the GCS buckets, the service
# account and its HMAC key for the observability stack. Needs gcloud logged in to YOUR project.
#
#   GCP_PROJECT=my-proj scripts/gcs-setup.sh            # print only
#   GCP_PROJECT=my-proj scripts/gcs-setup.sh --run      # execute (creates billable buckets)
#
# Env: GCP_PROJECT (required), GCS_LOCATION (us-central1: same region as Hexclave's GCP runtime,
# so VM<->bucket traffic is free), CH_BUCKET (hexclave-obs-ch), REPLAY_BUCKET (hexclave-obs-replays),
# REPLAY_TTL_DAYS (30), SA_NAME (hexclave-obs-storage)
set -euo pipefail
: "${GCP_PROJECT:?set GCP_PROJECT}"
LOC="${GCS_LOCATION:-us-central1}"; CH="${CH_BUCKET:-hexclave-obs-ch}"; RP="${REPLAY_BUCKET:-hexclave-obs-replays}"
SA="${SA_NAME:-hexclave-obs-storage}@${GCP_PROJECT}.iam.gserviceaccount.com"
run() { if [[ "${1:-}" == --run ]]; then shift; echo "+ $*"; "$@"; else shift; echo "$*"; fi; }
M="${1:-}"
LC=$(mktemp); printf '{"rule":[{"action":{"type":"Delete"},"condition":{"age":%s,"matchesPrefix":["replays/"]}}]}\n' "${REPLAY_TTL_DAYS:-30}" > "$LC"
# Standard class, single region, uniform access, no public access. Soft delete OFF: it is on by
# default (7 days) and would bill every part ClickHouse deletes or TTL-drops for another week.
for b in "$CH" "$RP"; do
  run "$M" gcloud storage buckets create "gs://$b" --project "$GCP_PROJECT" --location "$LOC" \
    --default-storage-class STANDARD --uniform-bucket-level-access --public-access-prevention --soft-delete-duration 0
done
# Replay blobs are not covered by ClickHouse TTL; GCS lifecycle (not the S3 lifecycle API) expires them.
run "$M" gcloud storage buckets update "gs://$RP" --lifecycle-file "$LC"
run "$M" gcloud iam service-accounts create "${SA%%@*}" --project "$GCP_PROJECT" --display-name "Hexclave observability storage"
for b in "$CH" "$RP"; do
  run "$M" gcloud storage buckets add-iam-policy-binding "gs://$b" --member "serviceAccount:$SA" --role roles/storage.objectAdmin
done
# Prints accessId + secret ONCE: store them as CH_S3_ACCESS_KEY_ID / CH_S3_SECRET_ACCESS_KEY
# (and REPLAY_S3_*) in Hexclave Project Settings > Secrets, never in git.
run "$M" gcloud storage hmac create "$SA" --project "$GCP_PROJECT"
echo "# CH_S3_ENDPOINT=https://storage.googleapis.com/$CH/clickhouse/   REPLAY_BUCKET=$RP"

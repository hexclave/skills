#!/usr/bin/env bash
# Change hot-tier and retention windows on an existing deployment.
# Rewrites the table TTLs with ALTER TABLE ... MODIFY TTL. Safe to re-run.
#
# Usage:
#   scripts/set-retention.sh --hot-days 3 --ttl-days 30 [--replay-ttl-days 30] [--apply]
#     [--local-only] [--client "clickhouse-client ..."]        (default: prints SQL only)
#   --local-only (or CH_STORAGE_MODE=local): no S3 disk, so TTLs only DELETE (no TO VOLUME 'cold').
#
# Notes (verified locally on ClickHouse 26.8):
#  - Parts that are already older than the new hot window are moved to S3 by the
#    TTL materialization that MODIFY TTL triggers (materialize_ttl_after_modify=1).
#  - TTL moves only go hot -> cold. Raising --hot-days does NOT pull parts back to local disk.
#  - Deletes happen in TTL merges, which are throttled by merge_with_ttl_timeout (default 4h),
#    so expired data can linger a few hours past the window.
set -euo pipefail

HOT_DAYS="" TTL_DAYS="" REPLAY_TTL_DAYS="" APPLY=0
LOCAL_ONLY=0; [[ "${CH_STORAGE_MODE:-}" == local ]] && LOCAL_ONLY=1
CLIENT="${CH_CLIENT:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hot-days) HOT_DAYS="$2"; shift 2 ;;
    --ttl-days) TTL_DAYS="$2"; shift 2 ;;
    --replay-ttl-days) REPLAY_TTL_DAYS="$2"; shift 2 ;;
    --client) CLIENT="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --local-only) LOCAL_ONLY=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ "$HOT_DAYS" =~ ^[0-9]+$ && "$TTL_DAYS" =~ ^[1-9][0-9]*$ ]] || { echo "--hot-days and --ttl-days are required integers" >&2; exit 2; }
(( HOT_DAYS < TTL_DAYS )) || { echo "--hot-days must be smaller than --ttl-days" >&2; exit 2; }
REPLAY_TTL_DAYS="${REPLAY_TTL_DAYS:-$TTL_DAYS}"
[[ "$REPLAY_TTL_DAYS" =~ ^[1-9][0-9]*$ ]] || { echo "--replay-ttl-days must be a positive integer" >&2; exit 2; }

tiered() { # table time_expr hot ttl
  if (( LOCAL_ONLY )); then
    printf "ALTER TABLE %s MODIFY TTL %s + toIntervalDay(%s) DELETE;\n" "$1" "$2" "$4"
  else
    printf "ALTER TABLE %s MODIFY TTL %s + toIntervalDay(%s) TO VOLUME 'cold', %s + toIntervalDay(%s) DELETE;\n" "$1" "$2" "$3" "$2" "$4"
  fi
}
SQL="$(
  tiered otel.otel_logs 'toDateTime(Timestamp)' "$HOT_DAYS" "$TTL_DAYS"
  tiered otel.otel_traces 'toDateTime(Timestamp)' "$HOT_DAYS" "$TTL_DAYS"
  tiered otel.otel_traces_trace_id_ts 'toDateTime(Start)' "$HOT_DAYS" "$TTL_DAYS"
  for t in gauge sum histogram summary exp_histogram; do
    tiered "otel.otel_metrics_$t" 'TimeUnix' "$HOT_DAYS" "$TTL_DAYS"
  done
  tiered replay.chunks 'toDateTime(first_ts)' "$HOT_DAYS" "$REPLAY_TTL_DAYS"
  tiered replay.chunk_blobs 'toDateTime(first_ts)' "$HOT_DAYS" "$REPLAY_TTL_DAYS"
  printf "ALTER TABLE replay.sessions MODIFY TTL toDateTime(start_ts) + toIntervalDay(%s) DELETE;\n" "$REPLAY_TTL_DAYS"
  printf "ALTER TABLE replay.trace_sessions MODIFY TTL toDateTime(ts) + toIntervalDay(%s) DELETE;\n" "$REPLAY_TTL_DAYS"
)"

if (( ! APPLY )) || [[ -z "$CLIENT" ]]; then
  echo "-- dry run (pass --apply and --client to execute)"
  echo "$SQL"
  echo "-- If replay blobs are in a bucket, set its lifecycle to ${REPLAY_TTL_DAYS} days too."
  exit 0
fi

# Each statement runs separately so one failure is visible and the rest still apply.
while IFS= read -r stmt; do
  [[ -z "$stmt" ]] && continue
  echo "+ $stmt"
  # shellcheck disable=SC2086 # CLIENT is intentionally word-split
  $CLIENT --query "$stmt" </dev/null
done <<< "$SQL"
(( LOCAL_ONLY )) || echo "Remember: a replay bucket's lifecycle rule should match ${REPLAY_TTL_DAYS} days."

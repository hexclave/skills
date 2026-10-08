#!/bin/bash
# Chooses the storage layout before ClickHouse reads its config, then hands over to the
# official entrypoint (which runs initdb and drops to the clickhouse user).
#   CH_S3_ENDPOINT set   -> tiered: hot local volume + S3-compatible bucket (CH_S3_* required)
#   CH_S3_ENDPOINT unset -> local: one volume, TTL delete only
set -euo pipefail
d=/etc/clickhouse-server/config.d
if [[ -n "${CH_S3_ENDPOINT:-}" ]]; then
  for v in CH_S3_REGION CH_S3_BATCH_DELETE CH_S3_CACHE_SIZE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
    [[ -n "${!v:-}" ]] || { echo "hexclave: CH_S3_ENDPOINT is set but $v is not" >&2; exit 1; }
  done
  [[ "$CH_S3_ENDPOINT" == */ ]] || { echo "hexclave: CH_S3_ENDPOINT must end with /" >&2; exit 1; }
  rm -f "$d/20-hexclave-storage-local.xml"
  export CH_STORAGE_MODE=s3
else
  rm -f "$d/20-hexclave-storage.xml"
  export CH_STORAGE_MODE=local
fi
echo "hexclave: storage mode ${CH_STORAGE_MODE}"
exec /entrypoint.sh "$@"

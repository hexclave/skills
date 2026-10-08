#!/bin/sh
# OTel gateway entrypoint for Hexclave Deployments.
# Secrets arrive as env vars, so the bearer token file is written here at start-up.
set -eu
: "${OTEL_INGEST_TOKENS:?set OTEL_INGEST_TOKENS (comma-separated, one per tenant or rotation slot)}"
: "${CLICKHOUSE_HOST:?CLICKHOUSE_HOST must come from service(\"clickhouse\").hostname()}"
umask 077
printf '%s\n' "$OTEL_INGEST_TOKENS" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | { grep -v '^$' || true; } > /etc/otelcol-contrib/tokens.txt
n=$(wc -l < /etc/otelcol-contrib/tokens.txt)
[ "$n" -gt 0 ] || { echo "OTEL_INGEST_TOKENS has no usable token" >&2; exit 1; }
for t in $(cat /etc/otelcol-contrib/tokens.txt); do
  [ "${#t}" -ge 24 ] || { echo "every ingest token must be at least 24 characters" >&2; exit 1; }
done
export CLICKHOUSE_ENDPOINT="tcp://${CLICKHOUSE_HOST}:${CLICKHOUSE_NATIVE_PORT:-9000}?dial_timeout=10s"
export OTEL_QUEUE_DIR="${OTEL_QUEUE_DIR:-/var/lib/otelcol/queue}"
# Runtime-provided names when present (FLY_APP_NAME/FLY_REGION, K_SERVICE), else defaults.
export OTEL_GATEWAY_NAME="${OTEL_GATEWAY_NAME:-${K_SERVICE:-${FLY_APP_NAME:-otel-gateway}}}"
export OTEL_GATEWAY_REGION="${OTEL_GATEWAY_REGION:-${FLY_REGION:-unknown}}"
CONFIG=/etc/otelcol-contrib/config.yaml
case "${OTEL_QUEUE_STORAGE:-file}" in
  file) mkdir -p "$OTEL_QUEUE_DIR" ;;
  memory)
    # No persistent disk (Hexclave serverless / Cloud Run): drop the file_storage queue.
    sed -e '/storage: file_storage\/queue/d' -e 's/, file_storage\/queue\]/]/' "$CONFIG" > /tmp/otel-config.yaml
    CONFIG=/tmp/otel-config.yaml ;;
  *) echo "OTEL_QUEUE_STORAGE must be file or memory" >&2; exit 1 ;;
esac
echo "otel gateway: ${n} ingest token(s), exporting to ${CLICKHOUSE_HOST}, queue=${OTEL_QUEUE_STORAGE:-file}"
exec /otelcol-contrib --config="$CONFIG"

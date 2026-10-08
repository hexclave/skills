#!/bin/bash
# Runs on every boot (CLICKHOUSE_ALWAYS_RUN_INITDB_SCRIPTS=1) against the temporary
# localhost-only server the official entrypoint starts. Schema DDL is IF NOT EXISTS, so
# re-running is a no-op. Retention changes (OTEL_HOT_DAYS / OTEL_TTL_DAYS / REPLAY_TTL_DAYS)
# are applied with ALTER ... MODIFY TTL only when they differ from what was last applied,
# because MODIFY TTL re-materializes TTL on every part.
set -euo pipefail
: "${OTEL_HOT_DAYS:=1}" "${OTEL_TTL_DAYS:=30}" "${REPLAY_TTL_DAYS:=$OTEL_TTL_DAYS}"
ch=(clickhouse-client --host 127.0.0.1 --port 9000 -u default --multiquery)
mode="${CH_STORAGE_MODE:-local}" # set by hexclave/clickhouse/entrypoint.sh
# local mode: there is no 'cold' volume, so drop the "+ hot days TO VOLUME 'cold'," TTL element.
render() {
  sed -e "s/__OTEL_HOT_DAYS__/${OTEL_HOT_DAYS}/g" -e "s/__OTEL_TTL_DAYS__/${OTEL_TTL_DAYS}/g" \
      -e "s/__REPLAY_TTL_DAYS__/${REPLAY_TTL_DAYS}/g" "$1" |
  if [[ "$mode" == local ]]; then
    awk '/TO VOLUME .cold.,[[:space:]]*$/ { ind = $0; sub(/[^ \t].*$/, "", ind); getline nxt; sub(/^[ \t]*/, "", nxt); print ind "TTL " nxt; next } { print }'
  else cat; fi
}
for f in /etc/hexclave-obs/sql/otel-schema.sql /etc/hexclave-obs/sql/replay-schema.sql; do
  echo "hexclave: applying $(basename "$f") (storage=${mode} hot=${OTEL_HOT_DAYS}d ttl=${OTEL_TTL_DAYS}d replay=${REPLAY_TTL_DAYS}d)"
  render "$f" | "${ch[@]}"
done
state=/data/clickhouse/.hexclave-retention
want="${mode} ${OTEL_HOT_DAYS} ${OTEL_TTL_DAYS} ${REPLAY_TTL_DAYS}"
if [[ -f "$state" && "$(cat "$state")" != "$want" ]]; then
  echo "hexclave: retention changed ($(cat "$state") -> $want), running MODIFY TTL"
  CH_STORAGE_MODE="$mode" /usr/local/bin/set-retention.sh --hot-days "$OTEL_HOT_DAYS" --ttl-days "$OTEL_TTL_DAYS" \
    --replay-ttl-days "$REPLAY_TTL_DAYS" --apply --client "clickhouse-client --host 127.0.0.1 --port 9000 -u default"
fi
echo "$want" > "$state"

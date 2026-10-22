# Schema

Applied on every ClickHouse boot by `assets/hexclave/clickhouse/initdb/10-hexclave-schema.sh`
(the official image runs it because `CLICKHOUSE_ALWAYS_RUN_INITDB_SCRIPTS=1`). Every statement is
`CREATE ... IF NOT EXISTS`. Retention changes are applied with `ALTER TABLE ... MODIFY TTL` by
`scripts/set-retention.sh`, which runs only when the `(mode, hot, ttl, replay)` tuple in
`/data/clickhouse/.hexclave-retention` changes.

All MergeTree tables use `storage_policy = 'tiered'` and `ttl_only_drop_parts = 1`, and are
partitioned by day.

## `otel` database (OTel Collector ClickHouse exporter layout)

| Table | Order key | Notes |
|---|---|---|
| `otel_traces` | `(ServiceName, SpanName, toDateTime(Timestamp))` | Plus bloom/tokenbf skip indexes on TraceId and attributes |
| `otel_traces_trace_id_ts` (+ MV) | `(TraceId, Start)` | Fast trace-id lookup |
| `otel_logs` | `(toStartOfFiveMinutes(Timestamp), ServiceName, Timestamp)` | `TraceId`/`SpanId` included for log↔trace joins |
| `otel_metrics_sum` / `_gauge` / `_histogram` / `_exp_histogram` / `_summary` | `(ServiceName, MetricName, toStartOfHour(TimeUnix), cityHash64(Attributes), TimeUnix)` | One table per metric type |

TTL (local mode): `TTL toDateTime(<ts>) + INTERVAL {OTEL_TTL_DAYS} DAY DELETE`
TTL (S3 mode): `+ INTERVAL {OTEL_HOT_DAYS} DAY TO VOLUME 'cold', + INTERVAL {OTEL_TTL_DAYS} DAY DELETE`

## `replay` database

| Table | Engine / key | Purpose |
|---|---|---|
| `chunks` | ReplacingMergeTree(received_at), `(project_id, session_id, seq)` | Index of every uploaded chunk: object_key (`clickhouse:<key>` or bucket key), bytes, event count, first/last ts, url, distinct_id |
| `sessions` | AggregatingMergeTree, `(project_id, session_id)` (+ MV from chunks) | Session list: start/end, chunk count, bytes, distinct id, first url |
| `trace_sessions` | ReplacingMergeTree, `(trace_id, project_id, session_id)` | trace → replay links |
| `chunk_blobs` | ReplacingMergeTree(received_at), `(project_id, session_id, seq)` | **Default blob store**: `blob String CODEC(ZSTD(1))` holding the gzipped rrweb JSON. Written before the index row, so the index never points at a missing blob |

TTL: `REPLAY_TTL_DAYS` (default = `OTEL_TTL_DAYS`) on every replay table, `chunk_blobs` included.

## Users (`assets/clickhouse/users.d/90-hexclave-users.xml`)

| User | Password env | Grants | Networks |
|---|---|---|---|
| `default` | none | admin, **localhost only** (used by initdb) | ::1, 127.0.0.1 |
| `admin` | `CLICKHOUSE_ADMIN_PASSWORD` | all | localhost + fdaa::/16 |
| `otel_writer` | `CLICKHOUSE_OTEL_PASSWORD` | SELECT, INSERT, SHOW on `otel.*` | localhost + fdaa::/16 |
| `replay_rw` | `CLICKHOUSE_REPLAY_PASSWORD` | SELECT, INSERT, SHOW on `replay.*` | localhost + fdaa::/16 |
| `reader` | `CLICKHOUSE_READER_PASSWORD` | SELECT, SHOW on `otel.*`, `replay.*`; readonly profile | localhost + fdaa::/16 |

## Typed columns for hot attributes

The exporter's schema already materializes a few k8s resource attributes. Do the same for every
attribute your queries filter or group on. Reading one key out of `LogAttributes` /
`SpanAttributes` decodes the whole map row by row. On a shared-CPU box that was most of every
query's cost (measured in production on `otel_logs`):

| Read path | Server time | Read |
|---|---|---|
| through a view that CASTs the map | 4164 ms | 65 MB |
| one `LogAttributes['$host']` key | 2564 ms | 1.4 MB |
| typed column | 717 ms | 1.1 MB |
| 90-day `uniq` visitors, map vs typed | 148 ms → 24 ms | 63.5 MB → 3.0 MB |

```sql
ALTER TABLE otel.otel_logs
    ADD COLUMN IF NOT EXISTS Host LowCardinality(String) MATERIALIZED LogAttributes['host'],
    ADD COLUMN IF NOT EXISTS Country LowCardinality(String) MATERIALIZED LogAttributes['country'];
```

`ADD COLUMN ... MATERIALIZED` fills new parts only. Backfill old parts once with
`ALTER TABLE ... MATERIALIZE COLUMN ...` from the start script, and only while some active part
lacks the column (`system.parts` vs `system.parts_columns`) and no mutation is pending. Otherwise
every restart rewrites the whole table again. Don't put `MATERIALIZE COLUMN` in the boot schema.

Two more rules that paid off:
- Filter on the leading order-key column first (the event name, the service), then on time. That
  alone halved a query (370 → 180 ms).
- Don't read a `ReplacingMergeTree` with `FINAL` once its data is frozen and known to be
  duplicate-free. `FINAL` stopped partition pruning: 820 → 370 ms and 480 → 240 ms without it.

## Useful queries

```sql
-- error rate by service, last hour
SELECT ServiceName, countIf(StatusCode = 'Error') / count() AS err_rate, count() AS spans
FROM otel.otel_traces WHERE Timestamp > now() - INTERVAL 1 HOUR GROUP BY ServiceName ORDER BY spans DESC;

-- p95 latency by endpoint
SELECT ServiceName, SpanName, quantile(0.95)(Duration) / 1e6 AS p95_ms, count()
FROM otel.otel_traces WHERE SpanKind = 'Server' AND Timestamp > now() - INTERVAL 1 HOUR
GROUP BY ServiceName, SpanName ORDER BY p95_ms DESC LIMIT 20;

-- logs of one trace
SELECT Timestamp, SeverityText, Body FROM otel.otel_logs WHERE TraceId = {tid:String} ORDER BY Timestamp;

-- replays that touched a trace
SELECT project_id, session_id FROM replay.trace_sessions WHERE trace_id = {tid:String};

-- storage per table and disk
SELECT database, table, disk_name, formatReadableSize(sum(bytes_on_disk)) FROM system.parts
WHERE active AND database IN ('otel','replay') GROUP BY ALL ORDER BY ALL;
```

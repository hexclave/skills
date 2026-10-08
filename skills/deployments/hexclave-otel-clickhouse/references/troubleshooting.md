# Troubleshooting and gotchas

Everything here came up while dogfooding the stack, locally and on a real Hexclave project.

## Getting logs on Hexclave

- **Build logs:** `GET /api/latest/deployments/deployments/<deploymentId>/logs`. Look for
  `MARSHAL_TARGET_START/DONE <service>` and `MARSHAL_BUILD_FAILED`. One builder builds every service
  in turn, and **one failed build marks every service `skipped`**.
- **Runtime logs:** `GET /api/latest/deployments/services/<serviceId>/logs?follow=false&since_millis=<ms>`
  (NDJSON `{at_millis, stream, instance, text}`, about 100 lines per page; page with the largest `at_millis`).
  Runtime logs are **not redacted**, so filter secret values before pasting them anywhere.
- Headers: `x-stack-access-type: server`, `x-stack-project-id`, `x-stack-secret-server-key`.
- `scripts/hexclave-deploy.sh --logs <service>` wraps the runtime call and masks the values in `secrets.env`.

## Hexclave Deployments

| Symptom | Cause | Fix |
|---|---|---|
| Build: `COPY src ./src` → `"/src": not found` | The builder's Docker context is **always the upload root**. `rootDirectory` + `dockerfilePath` only locate the Dockerfile | Write every Dockerfile with root-relative paths (`COPY replay-ingest/src ./src`) and use `rootDirectory: "."` |
| Clients log `Authentication failed: password is incorrect` but the passwords are right | ClickHouse's real reason (server log) is `IP_ADDRESS_NOT_ALLOWED` from `::ffff:172.16.x.x`. `service("clickhouse").hostname()` goes through the runtime's internal TCP proxy, not straight over `fdaa::/16` | Users allow `172.16.0.0/12` and `::ffff:172.16.0.0/108` as well as `fdaa::/16` (already in `90-hexclave-users.xml`) |
| Spec changes for no visible reason | `hexclave.deploy.ts` reads `process.env` (secret fallbacks, sizing), and a stray shell variable leaked in | The deploy script runs the CLI under `env -i` with an allowlist; do the same if you call the CLI yourself |
| `secret()` value doesn't match `secrets.env` | A value stored under Project Settings → Secrets always wins over the `secret(key, default)` fallback | Delete the stored secret or store the same value |
| OTLP/gRPC doesn't work | Public services are HTTP/1.1 only (no h2 to the backend) | Use OTLP/HTTP (`:443`, `/v1/traces` etc.), protobuf or JSON |
| Runtime choice | With no `version` export the project uses the default runtime (Fly-backed). The first deploy pins the runtime for the project | Leave out the `version` export unless you mean to opt into a beta runtime |
| `Listen [0.0.0.0]:8123 failed: Address already in use` warnings in ClickHouse | `listen_host ::` already accepts IPv4 | Harmless |

## ClickHouse

| Symptom | Fix |
|---|---|
| `Element <max_size> has value and does not have 'replace' attribute, can't process from_env substitution` | No inline defaults next to `from_env` in config.d. Every `from_env` var must be set (the entrypoint checks them when `CH_S3_ENDPOINT` is set) |
| `SAXParseException: Invalid token` at startup | An XML comment contains `--` (for example a CLI flag). Never put `--flags` in ClickHouse XML comments |
| `clickhouse client -q "INSERT ..."` hangs in a script | The client waits on stdin. Use `< /dev/null` or `--queries-file` |
| `ILLEGAL_AGGREGATION` with `sum(rows) rows` or `anyLast(distinct_id) AS distinct_id` | ClickHouse resolves SELECT aliases before columns in WHERE/GROUP BY. Never alias an aggregate to an existing column name |
| Trace lookup through `otel_traces_trace_id_ts` returns 0 rows | Start/End are second-precision DateTime and Timestamp is DateTime64(9). Use `max(End) + 1` as the upper bound |
| Data outlives TTL by a few hours | Deletes are throttled by `merge_with_ttl_timeout` (4h default). Expected |
| Raising `OTEL_HOT_DAYS` doesn't bring data back to local disk | TTL moves are one-way |
| Moved-to-cold data is slow on first read | TTL moves don't fill the filesystem cache. The first read pays S3 GETs (56 ms vs 11 ms warm, measured) |
| Switching from S3 back to local-only | Not possible in place, because a storage policy can't lose a volume. Treat S3 tiering as one-way |
| GCS as the S3 disk | `CH_S3_BATCH_DELETE=false` (GCS has no DeleteObjects) and HMAC keys. Verified against a MinIO stand-in, untested on GCS itself |
| Never | Put a bucket lifecycle rule on the ClickHouse disk bucket: expiring objects corrupts parts |

## OTel Collector gateway

- A collector restarting with a **file_storage** queue logs `Exporting failed. Dropping data ... dropped_items: N`
  for in-flight batches. That message is misleading: those batches weren't acked and are replayed after restart.
  Measured: 50,000 sent, 50,000 rows, no duplicates, through a ClickHouse outage plus a collector restart.
- `OTEL_QUEUE_STORAGE=memory` drops the disk queue (for runtimes without a disk). Queued data is then lost on restart.
- Tokens: `OTEL_INGEST_TOKENS` is comma-separated. An empty or whitespace-only list fails at start with a clear error.
- Collector-contrib 0.162.0 has no telemetrygen release tarball. Build it with `go install
  github.com/open-telemetry/opentelemetry-collector-contrib/cmd/telemetrygen@v0.162.0`.
- telemetrygen: `metrics` defaults to Gauge (`--metric-type Sum` to fill otel_metrics_sum); the default
  `--rate 1` looks hung for bulk runs (`--rate 0 --duration 5s`).

## SDK side

- **Node ESM:** without `module.register("@opentelemetry/instrumentation/hook.mjs", import.meta.url)` at the
  top of the instrumentation file, `node:http` isn't instrumented. You get split traces and no SERVER spans.
  `assets/client/otel-node.ts` does this.
- `new BatchLogRecordProcessor(exporter)` no longer typechecks (sdk-logs ≥0.2xx). Use `{ exporter }`.
- Under bursts, about 0.4% of logs were dropped by the default `maxQueueSize` 2048. Raise it for chatty services.

## Replay

- Replay blobs in a bucket aren't covered by ClickHouse TTL. Add a lifecycle Expiration rule on `replays/`.
  In the default mode (`replay.chunk_blobs`), the table TTL covers them.
- `object_key` is either `clickhouse:<project>/<session>/<seq>.json.gz` or a bucket key, so switching to a
  bucket later keeps old sessions playable.
- The last chunk is sent with `sendBeacon` on `pagehide` as plain JSON (no gzip). The server accepts both.
- Killing a Bun dev server: under pnpm the process is named `bun.exe`, so `pkill -f "bun run"` misses it. Kill by PID.
- Masking is on by default: inputs and `[data-private]` text become `*`, and `[data-replay-block]` elements aren't recorded.

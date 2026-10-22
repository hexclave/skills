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
- The same through the CLI, with no headers to build: `hexclave exec` with
  `p.getDeploymentServiceLogs(serviceId, { sinceMillis, follow: false, onLine })` and
  `p.getDeploymentBuildLogs(deploymentId)` (see [operations.md](operations.md)).
- There's no shell into a running container. What you need from inside has to reach the logs.
- `deployed` doesn't mean healthy: a crash-looping container still reports `deployed`. Read the
  runtime logs after every deploy.

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
| Build: `COPY app/ ./` → `"/app": not found`, though `app/` is in the deploy dir | `hexclave deploy` packages the upload with every `.gitignore` **and** `.dockerignore` applied (git semantics, at every directory level). A gitignored build copy never gets uploaded | Re-include it in `.dockerignore`: `*`, `!Dockerfile`, `!app/`, `!app/**`, then exclude `app/node_modules` and build outputs (`assets/dashboard/dockerignore`) |
| `... cannot be embedded in a string. References must be used as the WHOLE env var value` | `` `http://${service("x").hostname()}:8123` `` in the deploy file. References can't be interpolated | Pass the bare reference (`CLICKHOUSE_HOST: service("clickhouse").hostname()`) and build the URL in code, or use `service("x").url(port)` |
| `npx @hexclave/cli@latest` fails with `ETARGET No matching version found for @hexclave/shared@... with a date before ...` | npm's `minimum-release-age` setting refuses packages that are too new | Pin a version that's old enough (`@hexclave/cli@<x.y.z>`). The deploy script pins one; `HEXCLAVE_CLI` overrides it |
| `The env var connection "x.hostname" points to a service that doesn't exist in this project` | A deploy file references a service of another group that hasn't been deployed yet | Deploy the referenced group first. If two groups reference each other, deploy one first without those references |
| `a deployment may declare at most 20 targets` | Too many services in one group | Split it into deployment groups |
| Build: `ResourceExhausted ... no space left on device`, exit 137, or `MARSHAL_BUILD_TIMEOUT ... 900 seconds` | The builder ran out of disk (a multi-GB base image), memory (default 8GB) or its 15-minute budget | Run big stock images with `image:` instead of building `FROM` them; raise `builder: { memory: "16GB" }` in the deploy return; build heavy static sites locally and upload only the output |
| A renamed service or group comes up with an empty volume | A volume belongs to the group and service id. Renaming detaches the old disk, which keeps billing, and there's no tenant API to delete it | Keep the names. Ask Hexclave support to remove stranded disks |
| Redeploying ClickHouse makes the collector log `Exporting failed. Dropping data` | With a **memory** queue, batches still queued when the retry window ends are lost | Deploy ClickHouse alone (`hexclave deploy --service-id clickhouse`) so the collector keeps running; keep the file queue on the gateway |
| nginx in front of a private service fails to resolve it | Private hostnames (`*.flycast`) are IPv6 only | `resolver <local resolver> ipv6=on;` with a `set $upstream ...` per location (see `assets/edge/nginx-telemetry.conf`) |
| A public site (`serverless`) is slow on the first visit after a quiet spell | `serverless` defaults to `minInstances: 0` and **stops** on scale-down, so the next request is a cold start | `minInstances: 1` (paid plan) |

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
| `Too many open files` (errno 24) under a few parallel queries | Raise `ulimit -n` in the start script (`ulimit -n 1048576 \|\| ulimit -Sn "$(ulimit -Hn)"`) and keep small parts compact (`min_bytes_for_wide_part`), since wide parts with Map columns open a file per column |
| Reads crawl on a 4GB server, load average far above 2 | 4GB is shared-cpu-2x on Fly; `SELECT value FROM system.asynchronous_metrics WHERE metric = 'OSStealTimeNormalized'` shows the steal. Use 8GB (dedicated cores) and typed columns ([schema.md](schema.md#typed-columns-for-hot-attributes)) |
| A trivial query takes seconds while a dashboard is open | Too many concurrent reader queries. Limit concurrency and cache in the client ([dashboard.md](dashboard.md)), and check `system.processes` |

## OTel Collector gateway

- A collector restarting with a **file_storage** queue logs `Exporting failed. Dropping data ... dropped_items: N`
  for in-flight batches. That message is misleading: those batches weren't acked and are replayed after restart.
  Measured: 50,000 sent, 50,000 rows, no duplicates, through a ClickHouse outage plus a collector restart.
- `OTEL_QUEUE_STORAGE=memory` drops the disk queue (for runtimes without a disk). Queued data is then lost on restart,
  and there `Dropping data` is real: a production collector with a memory queue lost a few seconds of events
  while ClickHouse restarted.
- The file queue lives on the instance's root filesystem. A `serverless` instance that's stopped starts again from a
  clean rootfs, which is one more reason the gateway keeps `minInstances == maxInstances`.
- `geoip` processor: `could not open geoip database` stops the whole pipeline, and only GeoIP2/GeoLite2 City
  databases are accepted. See [variants.md](variants.md#country-from-the-client-ip-geoip) for DB-IP Lite.
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

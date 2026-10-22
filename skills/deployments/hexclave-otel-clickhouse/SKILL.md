---
name: hexclave-otel-clickhouse
description: Self-hosted observability on Hexclave Deployments that replaces New Relic. Deploys ClickHouse, an OpenTelemetry Collector gateway (OTLP/HTTP with bearer-token auth) and an rrweb session-replay ingest service with a built-in player, then verifies them end to end. Use when the user wants to send OTel traces, logs or metrics from apps hosted on Hexclave, drop New Relic, Datadog or PostHog, migrate product analytics off PostHog Cloud, store telemetry or product analytics in ClickHouse, record and replay browser sessions with rrweb, build a private dashboard on that ClickHouse, or operate such a stack (domains, secrets, logs, single-service deploys) through the Hexclave CLI.
license: MIT
compatibility: Needs a Hexclave project on a paid plan (always-on 8GB server, 500GB volume), HEXCLAVE_PROJECT_ID and HEXCLAVE_SECRET_SERVER_KEY, bash, curl, python3 and Node 20+ (npx). Docker, Bun, Go (telemetrygen) and Playwright are only needed for local tests. An S3-compatible bucket is optional.
metadata:
  author: hexclave
  version: "1.1.0"
  verified-on: "Hexclave Deployments default runtime, @hexclave/cli 1.0.125, ClickHouse 26.8.20.9, otelcol-contrib 0.162.0, Bun 1.4.2, rrweb 2.1.7 (2026-10-08); production variant and dashboard on @hexclave/cli 1.0.130 (2026-10-19)"
---

# Hexclave OTel + ClickHouse (New Relic replacement)

Three services in one Hexclave deployment group (`observability`), on the **default runtime**
(no `version` export in the deploy file):

| Service | What | Exposure |
|---|---|---|
| `clickhouse` | ClickHouse 26.8 server, 8GB, always on, 500GB volume | private only |
| `otel-gateway` | OTel Collector contrib: OTLP/HTTP in, bearer tokens, ClickHouse exporter, disk queue | public HTTPS |
| `replay-ingest` | Bun service: rrweb chunk ingest, session list, player, OTel row-count summary | public HTTPS |

No bucket is needed. By default ClickHouse keeps everything on its volume with a TTL delete, and
replay chunks are stored gzipped in `replay.chunk_blobs`. A bucket can be added later for a cold
tier and for replay blobs (see "Optional object storage").

Read [references/architecture.md](references/architecture.md) for the diagram and data flow.
For a site-analytics layout with one public nginx in front of private services, see
[references/variants.md](references/variants.md).

## Prerequisites

- `HEXCLAVE_PROJECT_ID` and `HEXCLAVE_SECRET_SERVER_KEY` for the target project. Never print the key.
- The project's plan must allow an always-on 8GB `server` and a 500GB volume. If it doesn't,
  `--apply` fails at the definitions sync, before anything is uploaded.
- Deploying creates billable resources. Get the user's explicit go-ahead for the specific project first.
- Deploy to the project the user named, and no other.

## Workflow

Run everything from a scratch directory outside the app repo. `secrets.env` is created there.

1. **Dry run** (no network). This assembles `.hexclave-obs-deploy/` and generates secrets once into
   `./secrets.env` (chmod 600, never overwritten):
   ```bash
   <skill>/scripts/hexclave-deploy.sh
   ```
   Generated: 4 ClickHouse passwords (admin, otel_writer, replay_rw, reader), `OTEL_INGEST_TOKENS`
   (`otlp_…`), `REPLAY_WRITE_KEYS` (`<project>:pk_…`) and `REPLAY_READ_TOKEN`. They're passed as
   `secret(KEY, fallback)` values. A value stored in Project Settings → Secrets overrides them.
2. **Read-only check** (optional): `--check` lists the project's existing services and deployments.
3. **Deploy:**
   ```bash
   HEXCLAVE_PROJECT_ID=... HEXCLAVE_SECRET_SERVER_KEY=... <skill>/scripts/hexclave-deploy.sh --apply
   ```
   This runs `npx -y @hexclave/cli@1.0.125 deploy` under `env -i` with an allowlist, because the
   deploy file reads `process.env`. It waits for the build and rollout and prints the public URLs.
   A full build takes about 5–8 minutes. Output is tee'd to `.hexclave-obs-deploy/deploy.log`.
4. **Verify** against the public URLs (exits 1 if any check fails):
   ```bash
   GATEWAY_URL=https://... REPLAY_URL=https://... <skill>/scripts/hexclave-deploy.sh --verify
   ```
   The checks: 401 without a token, an OTLP log accepted with the token, replay health, read-token
   auth, and the log row visible in ClickHouse through `GET /v1/otel/summary`.
5. **Full verification** (recommended before handing over):
   - Traces, logs and metrics with telemetrygen:
     ```bash
     H="Authorization=\"Bearer $TOKEN\""; E=${GATEWAY_URL#https://}
     telemetrygen traces  --otlp-http --otlp-endpoint $E:443 --otlp-header "$H" --traces 50 --rate 0 --service tg-verify
     telemetrygen logs    --otlp-http --otlp-endpoint $E:443 --otlp-header "$H" --logs 50 --rate 0 --service tg-verify
     telemetrygen metrics --otlp-http --otlp-endpoint $E:443 --otlp-header "$H" --metrics 50 --rate 0 --metric-type Sum --service tg-verify
     curl -s "$REPLAY_URL/v1/otel/summary?minutes=15&service=tg-verify" -H "authorization: Bearer $REPLAY_READ_TOKEN"
     ```
   - A browser session: load a page that uses `assets/client/replay-recorder.ts` with the deployed
     URL and write key, click around, then open
     `$REPLAY_URL/player/<project>/<sessionId>#token=$REPLAY_READ_TOKEN`.
6. **If anything fails**, read the logs (secrets masked) and see
   [references/troubleshooting.md](references/troubleshooting.md):
   ```bash
   <skill>/scripts/hexclave-deploy.sh --build-logs <deploymentId>
   <skill>/scripts/hexclave-deploy.sh --logs clickhouse        # or otel-gateway / replay-ingest
   ```
   Fix the cause, then re-run `--apply`. It's idempotent: the schema is applied with `IF NOT EXISTS`
   on every boot, and the volume keeps the data.

## Instrumenting apps

- **Any OTel SDK:** set
  `OTEL_EXPORTER_OTLP_ENDPOINT=<otel-gateway URL>`,
  `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` and
  `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20<otlp_token>`.
  Use OTLP/HTTP only: public Hexclave services don't carry gRPC.
- **Node:** `assets/client/otel-node.ts` sets up traces, logs and metrics, ESM-safe
  (`module.register` hook), and flushes on SIGTERM. Raise `maxQueueSize` for chatty services.
- **Browser replay:** bundle `assets/client/replay-recorder.ts` and call
  `startReplay({ endpoint, writeKey, sampleRate })`. Inputs and `[data-private]` text are masked,
  and `[data-replay-block]` elements are dropped. To link replays to traces, have your backend
  return `server-timing: traceparent;desc="00-<trace>-<span>-01"` and copy the
  `x-replay-session-id` request header onto spans as `session.id`.
- Several tokens or keys: comma-separate them in `OTEL_INGEST_TOKENS` / `REPLAY_WRITE_KEYS` (store
  them as project secrets to rotate without editing files).

## Querying and dashboards

The ClickHouse service is private, so the stack has no public SQL endpoint. Options:
- `GET /v1/otel/summary` on replay-ingest gives row counts only (smoke tests).
- Session APIs: `/v1/replay/sessions`, `/v1/replay/by-trace/<traceId>`, `/player/...`.
- **A ready-made UI** (Grafana with the ClickHouse plugin, or HyperDX) as another service in the same
  project, as the `reader` user (`CLICKHOUSE_READER_PASSWORD`). The `readonly_ui` profile already
  allows the session settings these tools need.
- **A custom private dashboard** with Hexclave Auth in front: [references/dashboard.md](references/dashboard.md)
  and `assets/dashboard/`. These are the parts that ran in production: a TanStack Start SPA, a server-side session
  and email-allowlist check, and a ClickHouse client that caps concurrency, coalesces and caches
  queries, and cancels abandoned ones.
- **SQL from a laptop or an agent:** a reader-only reverse proxy on a public service you already run
  ([references/operations.md](references/operations.md#reaching-the-private-clickhouse-from-a-laptop)).

Whatever reads it, a dashboard can starve ingest on a small box. Filter on the order key and time,
add typed `MATERIALIZED` columns for the attributes you filter on, and limit concurrent queries.
Table layouts, typed columns and example queries: [references/schema.md](references/schema.md).

## Operating it with the Hexclave CLI

Do admin work through `hexclave exec` (full admin through `hexclaveServerApp.getProject()`), not
the dashboard in a browser. [references/operations.md](references/operations.md) has the calls for
custom domains (`addDeploymentServiceDomain` and the DNS records it returns), project secrets,
runtime and build logs, and service state. It also covers:
- `hexclave deploy --service-id <id>` to roll out one service (for example ClickHouse alone, so the
  gateway keeps running);
- always-on vs scale-to-zero defaults per service type, and the 32GB always-on cap;
- volumes being tied to the group and service id (renaming gives an empty disk, and the old one
  keeps billing).

## Variant: product analytics behind your own site

When the sender is your own website, a smaller layout ran in production:
the site's nginx is the only public service and proxies same-origin OTLP logs, rrweb chunks and
reader SQL to a private collector, ClickHouse and SeaweedFS. It also adds GeoIP with DB-IP Lite. See
[references/variants.md](references/variants.md) and `assets/edge/nginx-telemetry.conf`. Keep the
default token-authenticated gateway for traces from apps on other networks.

## Migrating from PostHog Cloud

[references/posthog-migration.md](references/posthog-migration.md) covers a migration that ran in production
(76,700 events, counts equal to Cloud's):
- exporting through the PostHog MCP's `execute-sql`, which has a 500-row limit and a response cap of about 6.5 MB;
- loading with `scripts/posthog-migration/import-posthog.py`, which is safe to re-run;
- cutting over with overlapping deltas selected by receive time (`created_at`);
- keeping visitor ids and experiment variants with `assets/client/posthog-compat.ts`, which uses PostHog's own hash;
- querying old and new data through one PostHog-shaped view.

## Configuration

| Env (at deploy time) | Default | Effect |
|---|---|---|
| `OTEL_TTL_DAYS` | 30 | delete after N days |
| `OTEL_HOT_DAYS` | 1 | with S3 only: move to the cold tier after N days |
| `REPLAY_TTL_DAYS` | `OTEL_TTL_DAYS` | replay tables (including chunk_blobs) |
| `CH_VOLUME_GB` | 500 | ClickHouse volume size (1–500, grow-only) |
| `OTEL_GATEWAY_INSTANCES` | 2 | fixed gateway count |
| `OTEL_QUEUE_STORAGE` | file | `memory` drops the disk-backed queue |
| `REPLAY_PROJECT` | hexclave | project id inside the generated write key |
| `REPLAY_ALLOWED_ORIGINS` | `*` | CORS for the recorder |

Retention changes are applied at the next ClickHouse boot (`ALTER ... MODIFY TTL`, only when the
values changed). `scripts/set-retention.sh` does the same by hand.

## Operations: pause and resume

Hexclave Deployments has **no tenant-facing stop/park call**. The CLI has no stop/scale command, and
the backend's service routes are GET-only. "Parked" (`parked_at`, the parked page) is set only by
the platform itself, for example by the Free plan's 24h sweep. So pausing means redeploying with
every `minInstances` at 0:

```bash
cd <dir with secrets.env>   # same directory as the original deploy
HEXCLAVE_PROJECT_ID=... HEXCLAVE_SECRET_SERVER_KEY=... <skill>/scripts/hexclave-deploy.sh --pause    # OBS_SCALE_TO_ZERO=1
HEXCLAVE_PROJECT_ID=... HEXCLAVE_SECRET_SERVER_KEY=... <skill>/scripts/hexclave-deploy.sh --resume   # normal floors again
```

- While paused, idle machines stop: the serverless services stop, and ClickHouse suspends, or stops at 8GB.
  The 500GB volume and all data are kept (the volume is reused by name on every deploy), and so are
  secrets and public URLs.
- **A paused stack is not offline.** The runtime autostarts machines on the next request, so any
  OTLP export or replay upload wakes the gateway or replay-ingest, which then wakes ClickHouse. The first
  request after a pause takes several seconds while ClickHouse boots (initdb re-runs, which is a no-op). To
  really stop traffic, also stop the exporters and recorders in your apps.
- The volume still bills while paused, and the API still shows `status: deployed`, `parked_at: null`,
  with `min_instances: 0`.
- Both commands are full redeploys (about 5–8 minutes) and use the same `secrets.env`, so the passwords don't change.

## Optional object storage

Set all of these, or none:
- **ClickHouse cold tier:** `CH_S3_ENDPOINT` (with a trailing `/`), `CH_S3_ACCESS_KEY_ID`,
  `CH_S3_SECRET_ACCESS_KEY`, `CH_S3_REGION`. For GCS also set `CH_S3_BATCH_DELETE=false`.
  Parts older than `OTEL_HOT_DAYS` move to the bucket through a 200Gi local cache. This is **one-way**: a
  policy can't drop the volume later. Never add a lifecycle rule to this bucket.
- **Replay blobs:** `REPLAY_BUCKET`, `REPLAY_S3_ENDPOINT`, `REPLAY_S3_ACCESS_KEY_ID`, `REPLAY_S3_SECRET_ACCESS_KEY`
  (+ `REPLAY_S3_REGION`). Add a lifecycle Expiration rule on `replays/`, because ClickHouse TTL doesn't
  reach bucket objects. Old `clickhouse:`-keyed sessions stay playable.
- `scripts/gcs-setup.sh` prints (or runs) the gcloud commands for GCS buckets and HMAC keys.

## Gotchas (short list)

- The Docker build context is the **upload root** for every service. Keep Dockerfile paths root-relative.
- `service("clickhouse").hostname()` connects through the runtime's internal proxy (peer IP in 172.16.0.0/12).
  ClickHouse user network ACLs must include it, or clients get a misleading "password is incorrect".
- Runtime logs from the platform aren't redacted. Use `--logs`, which masks values from secrets.env.
- One failed image build marks every service `skipped`.
- XML comments in ClickHouse config must not contain `--`.
- `hexclave deploy` uploads with every `.gitignore` and `.dockerignore` applied. Re-include gitignored
  build copies in `.dockerignore`, or the remote build fails with `"/app": not found`.
- References (`service(...)`, `secret(...)`, `hexclave.*`) must be a whole env value. The CLI refuses
  them inside template strings.
- `deployed` doesn't mean healthy. Read the runtime logs after a deploy; there's no shell into containers.
- Private hostnames are IPv6 only (`*.flycast`). Proxies need `ipv6=on` resolvers.
- Below 8GB the CPU is shared and burstable. Under query load a 4GB ClickHouse loses most of its CPU to steal.

Measured numbers (throughput, compression, cold reads) and sizing: [references/costs.md](references/costs.md).

## What was verified (2026-10-08, live Hexclave project, default runtime)

- `--apply` built all 3 images remotely and rolled them out. `--verify` passed all 7 checks.
- telemetrygen over the public HTTPS gateway: 800 spans, 500 logs, 100 Sum and 100 Histogram points, all
  present in ClickHouse with exact counts.
- A Playwright rrweb session against the public replay-ingest: 2 chunks and 39 events stored in `replay.chunk_blobs`,
  masking confirmed in storage, 2 traces linked, and playback in the public player (ready in about 0.5s, no errors).
- Locally only (MinIO stand-in): the S3 cold tier, TTL moves, GCS-style single deletes, the replay bucket mode,
  and the durable queue across a ClickHouse outage. Not yet run on Hexclave with a real bucket.

## What ran in production (2026-09-30 to 2026-10-19, live Hexclave project, default runtime)

- The variant layout ([references/variants.md](references/variants.md)) served a website's analytics, session
  replays and update-check counts. It ran ClickHouse at 4GB, the collector at 512MB, SeaweedFS at 1GB, all always on,
  plus an always-on nginx site.
- The dashboard in [references/dashboard.md](references/dashboard.md) ran against it at a custom domain, with
  Hexclave Auth, and with the query gate and typed columns measured before and after.
- `--service-id` deploys, domain attach through `hexclave exec`, the `.dockerignore` re-include and the
  typed-column backfill across restarts were all run for real.

## Files

- `assets/hexclave/hexclave.deploy.ts`: the deployment spec (3 services).
- `assets/hexclave/{clickhouse,gateway,replay-ingest}/`: Dockerfiles and entrypoints (storage-mode switch, initdb schema).
- `assets/clickhouse/`: server, storage (local and S3), users config. `assets/sql/`: OTel and replay schemas.
- `assets/gateway/otel-collector.yaml`: the collector config.
- `assets/client/`: Node OTel bootstrap, browser rrweb recorder.
- `assets/dashboard/`: private dashboard pieces (ClickHouse gate and cache, Hexclave Auth check, SPA server, Dockerfile,
  `.dockerignore` template, deploy file and script).
- `scripts/posthog-migration/`: PostHog Cloud history importer and table. `assets/client/posthog-compat.ts`: posthog-js visitor ids and flag bucketing.
- `assets/edge/nginx-telemetry.conf`: same-origin ingest and reader proxy for the variant. `assets/gateway/fetch-geoip.mjs`: DB-IP Lite for the geoip processor.
- `scripts/hexclave-deploy.sh`: dry run, check, apply, verify, logs. `scripts/set-retention.sh`. `scripts/replay-ingest/`: service source.

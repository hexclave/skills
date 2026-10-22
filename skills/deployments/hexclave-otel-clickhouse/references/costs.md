# Costs and sizing

Hexclave doesn't publish per-resource prices for Deployments. Always-on services, more than
512MB of memory, `server` type and volumes over 10GB all need a paid plan. Check the
project's plan in the dashboard. So this page lists what the stack **consumes**, and
the measured numbers you need to size it.

## What the stack reserves

| Service | Always on | Memory / CPU | Disk |
|---|---|---|---|
| clickhouse | yes (`minInstances: 1`) | 8GB, 2 dedicated CPUs (performance class) | 1 volume, `CH_VOLUME_GB` (default 500GB, max 500, grow-only) |
| otel-gateway | yes (2 instances) | 2 x 2GB | ephemeral (file queue lives on the instance disk) |
| replay-ingest | 1 instance min, up to 4 | 1GB each | none |

That's 13GB of always-on memory against the project's 32GB always-on cap. To trim it, set
`OTEL_GATEWAY_INSTANCES=1` (1 gateway) and keep replay at min 1. ClickHouse needs the 8GB to merge
comfortably at a few thousand rows per second with the settings in `30-hexclave-8gb.xml`.

## CPU comes with the memory size

You choose memory, and CPU follows from it. On the default (Fly) runtime, from
`deploymentCpuForMemory` in `@hexclave/shared`:

| Memory | Machine | CPU |
|---|---|---|
| 512MB–2GB | shared-cpu-1x | 1 shared |
| 4GB | shared-cpu-2x | 2 shared (burstable) |
| 8GB | performance-2x | 2 dedicated |

Shared CPUs run on burst credit. A production 4GB ClickHouse that served dashboards showed
`OSStealTimeNormalized` 0.86 at idle and a load average near 18 once the credit was spent, and
queries that took 0.3 s took 7 s. Ingest alone was fine. Size anything people query interactively
at 8GB. A redeploy refills the credit for a while, which can make a 4GB box look fine in a short test.

Always-on services (effective `minInstances` ≥ 1) count against a 32GB per-project cap. Scale-to-zero
services don't count.

## Storage math (measured)

Compressed bytes per row, from the dogfood runs (ZSTD, after merges):

| Data | Bytes/row | Notes |
|---|---|---|
| Logs (realistic app logs) | ~110 B | 7.6x compression; synthetic identical logs get 5.6 B, so don't size from those |
| Spans (HTTP + DB) | ~50 B | 15x |
| Trace-id index | ~20 B/trace | |
| Replay (gzip, in `chunk_blobs`) | ~3 KB for the 3-second, 39-event test session (2 chunks) | Scales with DOM churn and session length. Measure your own app: `sum(bytes_gz)` in `replay.chunks` |

Example: 50M spans/day + 20M logs/day ≈ 50M×50 + 20M×110 ≈ **4.7 GB/day** → 30 days ≈ 140 GB.
The 500GB volume then gives about 3x headroom. If you need longer retention than the volume
holds, add a bucket (`CH_S3_*`) and the cold tier keeps only recent days local.

## Throughput (measured on one 8-vCPU test box, all components sharing it)

- 380k logs/s and 84k spans/s end to end through one collector into one ClickHouse.
  These are lower bounds for the pipeline. On Hexclave each gateway instance is a separate machine.
- Node app with full auto-instrumentation at ~3k req/s: the app, not the gateway, was the bottleneck.

## Versus New Relic

New Relic bills by ingested GB (beyond a free monthly allowance) plus per full-platform user.
This stack bills only by reserved resources, so cost stays flat as volume grows until the
volume or CPU is full. Get current New Relic prices from their pricing page before comparing.
The example volume above (≈ 4.7 GB/day compressed, roughly 40–70 GB/day of raw telemetry) would be
about 1.2–2 TB/month of billable New Relic ingest.

## Optional bucket costs

With `CH_S3_*` or `REPLAY_BUCKET` set you also pay the provider's storage and request prices. Two things
to plan for:
- On GCS, set `CH_S3_BATCH_DELETE=false` (no multi-object delete). Each part deletion then costs one
  DELETE per object.
- Replay objects in a bucket aren't covered by ClickHouse TTL. Add a lifecycle Expiration rule on
  the `replays/` prefix. **Never** add a lifecycle rule to the ClickHouse disk bucket.

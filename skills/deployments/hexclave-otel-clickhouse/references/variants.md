# Variant: product analytics behind your own site

The default stack exposes two public services (`otel-gateway`, `replay-ingest`) with tokens and
write keys. When the main sender is your own website (product analytics, a PostHog replacement),
a smaller layout has run in production since 2026-09-30:

| Service | Type | Exposure | Notes |
|---|---|---|---|
| `site` | `serverless`, nginx, min 1 | **the only public service** | serves the site and proxies `/otel/*`, `/_ch/`, `/_replays/` to the private services (`assets/edge/nginx-telemetry.conf`) |
| `otel-collector` | `server`, 512MB, min 1 | private, 4318 + 13133 (health) | logs pipeline only: events are OTLP log records, one attribute map per event |
| `clickhouse` | `server`, 4GB, min 1, 20GB volume | private, 8123 + 9000 | `otel_logs` as a ReplacingMergeTree keyed `(Event, toDate(Timestamp), Uuid)` with typed columns |
| `objects` | `server`, SeaweedFS, 1GB, min 1, 20GB volume | private, 8888 | rrweb chunks as objects; the filer TTL deletes them after 30 days |

What it buys:
- The browser posts to its own origin (`/otel/v1/logs`), so there's no CORS and no token in the page.
  nginx drops the incoming headers, rate-limits per client and forwards the client IP. The real
  client address is `Fly-Client-IP`, not `X-Forwarded-For`.
- The collector, ClickHouse and object store have no public surface at all.
- Read access for scripts and agents goes through the same nginx: `/_ch/` for the `reader` user only,
  and `/_replays/` behind a bearer token (see [operations.md](operations.md#reaching-the-private-clickhouse-from-a-laptop)).

What it costs:
- No bearer-token auth on ingest. The rate limits and body caps are the only protection, which suits
  analytics and doesn't suit app traces from other networks. Keep the default gateway for those.
- The collector's queue is in memory. Restarting the collector, or ClickHouse for longer than the
  retry window, loses what's queued. A redeploy that restarted ClickHouse logged
  `Exporting failed. Dropping data` three times. Deploy ClickHouse alone with `--service-id` and
  keep `retry_on_failure.max_elapsed_time` at about 10m.

## SeaweedFS as the replay store

Run the stock image with `image:` + `startCommand` (no build step):

```ts
objects: {
  type: "server",
  minInstances: 1,
  memory: "1GB",
  ports: { 8888: { protocol: "tcp" } },
  image: "docker.io/chrislusf/seaweedfs@sha256:<digest>",
  startCommand:
    "mkdir -p /data/weed && cd /data/weed && " +
    "{ (until echo 'fs.configure -locationPrefix=/buckets/replays/ -ttl=30d -apply' | weed shell -master=localhost:9333 2>/dev/null | grep -q replays; do sleep 3; done) & } && " +
    "exec weed server -dir=/data/weed -filer -master.volumePreallocate=false -volume.max=200",
  persistentVolumes: { objects: { path: "/data", sizeGb: 20 } },
}
```

`startCommand` runs as one `/bin/sh -c` line. An earlier version joined an array of steps with
spaces: it reported `deployed` while the container crash-looped on `syntax error: unexpected word`.

## Country from the client IP (GeoIP)

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
        include_metadata: true
processors:
  attributes/client-ip:
    actions:
      - { key: client.address, from_context: metadata.x-real-ip, action: upsert }
  geoip:
    context: record
    error_mode: silent
    providers:
      maxmind:
        database_path: /etc/otelcol-contrib/dbip-city-lite.mmdb
  transform/clean:
    error_mode: ignore
    log_statements:
      - context: log
        statements:
          - set(attributes["country"], attributes["geo.country.iso_code"]) where attributes["geo.country.iso_code"] != nil
          - delete_matching_keys(attributes, "^geo\\.")
          - delete_key(attributes, "client.address")
```

Put the processors in the logs pipeline in that order (`memory_limiter, attributes/client-ip, geoip,
transform/clean, batch`). The IP is used for the lookup and then dropped, never stored.

The database: `assets/gateway/fetch-geoip.mjs` downloads DB-IP's free City Lite (CC BY 4.0: link to
db-ip.com where you show the data), checks its sha256, and relabels its `database_type`. The geoip
processor refuses anything but GeoIP2/GeoLite2 City types, and the pipeline won't start without
the file. Add a build stage to the gateway Dockerfile:

```dockerfile
FROM node:22-alpine AS geoip
COPY gateway/fetch-geoip.mjs /fetch-geoip.mjs
RUN node /fetch-geoip.mjs 2026-10 <npm mirror version> <sha256 of the .mmdb.gz> /dbip-city-lite.mmdb \
 && test "$(stat -c %s /dbip-city-lite.mmdb)" -gt 1000000
# ...then in the final stage:
COPY --from=geoip /dbip-city-lite.mmdb /etc/otelcol-contrib/dbip-city-lite.mmdb
```

The npm package `dbip-city-lite` mirrors the same bytes, so the build still works after DB-IP
takes the month down.

## ClickHouse on a 4GB box

4GB is Fly's shared-cpu-2x: fine for ingest, slow for reads once the burst credit is spent
(`OSStealTimeNormalized` 0.86 at idle). What kept it usable, all in production:
- typed `MATERIALIZED` columns for every attribute a query filters on ([schema.md](schema.md#typed-columns-for-hot-attributes));
- `ulimit -n 1048576` in the start script and compact parts (`min_bytes_for_wide_part = 1GiB`, plus
  `OPTIMIZE ... FINAL` at boot for small wide parts). Four parallel queries had hit
  `Too many open files` (errno 24) on wide parts full of Map columns;
- trimmed system logs (`query_log`/`part_log` TTL 7 days, `text_log`, `trace_log` and the other
  noisy ones removed or 3 days), `mark_cache_size` 256MB, `uncompressed_cache_size` 0;
- no `FINAL` in views over history that no longer changes (it blocked partition pruning: 820 → 370 ms).

If people will query it interactively, 8GB (two dedicated cores) is worth the price.

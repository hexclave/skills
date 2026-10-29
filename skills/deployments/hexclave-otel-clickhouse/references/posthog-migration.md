# Migrating from PostHog Cloud

This is how a live site moved its product analytics off PostHog Cloud (EU) onto this stack in one
afternoon, 2026-09-30, without losing events, visitors or experiment assignments. The layout was the
site-analytics variant ([variants.md](variants.md)). Files: `scripts/posthog-migration/`,
`assets/client/posthog-compat.ts`.

Result: 76,700 events copied, equal to Cloud's own count of everything it had received up to the
cutoff. Per-event counts matched, the stats pipeline gave the same numbers on both sides, and every
recorded experiment exposure (1,318 of 1,318) reproduced.

## What carries over, and what doesn't

| Carried over | How |
|---|---|
| Events (all properties, `elements_chain`, `person_id`) | exported with HogQL, loaded into `telemetry.posthog_events` |
| Visitor ids | the new sender reads posthog-js's stored `distinct_id` (`legacyDistinctId`) |
| Flag and experiment variants | PostHog's hash, reproduced client-side (`posthogVariant`) |
| Event and property names | the new sender keeps PostHog's names (`$pageview`, `$host`, `$session_id`, `$elements_chain`, ...) |

Not migrated: session recordings (3,871 sessions, about 461 MB; only their metadata list was kept),
PostHog Logs, persons beyond their ids, cohorts, insights, dashboards, error-tracking issues. Save the
definitions as JSON for reference and rebuild what you need as SQL. Check how many persons and
identify/alias/merge events exist before deciding persons don't matter. In this project there was 1
person and none of those events.

## 1. Export with the PostHog MCP

The batch-export file download needs an authenticated REST call. With only the PostHog MCP
available, `execute-sql` (HogQL) works, within two limits:
- **at most 500 rows per query**, so pack many events into one row:
  ```sql
  SELECT count() AS n, arrayStringConcat(groupArray(j), '\n') AS body FROM (
    SELECT concat('{"uuid":', toJSONString(toString(uuid)),
                  ',"event":', toJSONString(event),
                  ',"distinct_id":', toJSONString(distinct_id),
                  ',"timestamp":', toJSONString(formatDateTime(toTimeZone(timestamp, 'UTC'), '%Y-%m-%dT%H:%i:%S.%fZ')),
                  ',"person_id":', toJSONString(toString(person_id)),
                  ',"properties":', if(properties = '', '{}', toString(properties)), '}') AS j
    FROM events
    WHERE timestamp >= {window_start} AND timestamp < {window_end} AND created_at < {C0}
    ORDER BY timestamp, uuid
  )
  ```
- **about 6.5 MB per response.** One try at 16 MB ended the MCP session. Count events per 10 minutes
  first, then plan windows that stay under the cap (45 windows for 73k events, 239 MB of JSONL).

Big MCP results land in a file rather than inline. Parse that file, and check every window: the
row count equals `n`, and every timestamp falls inside the window. `elements_chain` is its own column
in PostHog. Export it by uuid for the click events (`$autocapture`) and merge it in, or add it to
the `concat`.

Identical HogQL queries return cached results. Vary the text slightly (an extra bound, an alias) when
you re-check a count.

## 2. Load

Create `scripts/posthog-migration/posthog-events.sql` in the schema, then run:

```bash
CLICKHOUSE_URL=https://<your proxy>/_ch/ CLICKHOUSE_USER=importer CLICKHOUSE_PASSWORD=... \
  python3 scripts/posthog-migration/import-posthog.py events.jsonl
```

- Use a dedicated `importer` ClickHouse user with `INSERT` (and `SELECT`, for checking) on the history
  table only. Remove the user and its grants once the migration is closed.
- The `/_ch/` route in `assets/edge/nginx-telemetry.conf` lets only `reader` through. For the load,
  add `"importer:" 1;` to its `$ch_auth_ok` map (the script sends `X-ClickHouse-User`), and take
  it out again with the user.
- The table is a `ReplacingMergeTree` keyed on `(event, toDate(timestamp), uuid)`, so re-runs and
  overlapping files are safe. Count with `uniqExact(uuid)` or `FINAL`.
- Property values are stored as strings: JSON values become their JSON text (`true`, `12`), and nulls
  are dropped, which is what the collector does with attributes too.
- 73k events loaded in about 44 s over the public proxy.

## 3. Cut over with overlapping deltas

The site keeps sending to PostHog until the new sender is live, so the history is exported in passes:

1. **Bulk:** everything received before C0 (`created_at < C0`, C0 just before the export starts),
   in event-time windows that run up to now.
2. Deploy the stack, deploy the site routes, and test them live.
3. Switch the senders (site, app, any server-side mirrors).
4. **Deltas by receive time, not event time:** `created_at >= C0 - INTERVAL 1 HOUR AND created_at < T1`,
   with T1 after the switch. Make passes overlap; the uuid key removes the duplicates.

Why one receive-time cutoff: events reach PostHog late. Here, 9 update-check events dated midnight
(the sender only knew the date) arrived after the bulk export. And while the bulk cut on event time
and the delta on receive time, 68 events dated after the bulk's cutoff but received before the bulk
export started fell into neither pass. HogQL's `events` table has `created_at` but no `inserted_at`
or `_timestamp`.

Reconcile on both sides with the same windows: total, `uniqExact(uuid)`, a per-event `GROUP BY event`,
and the numbers your reports actually show (visitors, conversions). Stop when all of them match.
Clients that can't be updated (old app builds) keep posting to PostHog after the cutoff. Decide
whether you need those events. Here, nothing read them.

## 4. Keep identities and experiments

- **Visitors:** posthog-js stores `{"distinct_id": ...}` under `ph_<project token>_posthog` in
  localStorage or a cookie. Reuse it (`legacyDistinctId`), so history and new events share ids. Only
  mint a new id (UUIDv7) when there's none. New sessions follow posthog-js's rules (30 minutes idle,
  24 hours max).
- **Flags:** PostHog buckets with `sha1("<flag key>.<distinct id><salt>")`. It takes the first 15 hex
  digits, compares them against `0xfffffffffffffff`, and uses salt `""` for the rollout and
  `"variant"` for the variant split. `posthogVariant` reproduces it. Keep sending
  `$feature_flag_called` / `$experiment_exposure` with the same properties (flag id, version,
  `$feature/<key>`) so experiment analysis keeps working across the boundary.

## 5. Query it like PostHog

- One view over both sources: `UNION ALL` of the new `otel_logs` rows (mapped to `uuid, event,
  distinct_id, session_id, timestamp, properties, elements_chain`) and `posthog_events`, with a `source`
  column (`'posthog-cloud'` for the history). Leave self-test traffic out of the view.
- HogQL to ClickHouse SQL: `properties.$host` becomes `properties['$host']`, and booleans are the
  strings `'true'`/`'false'` (`properties['first'] = 'true'`). Check `$lib` and `$host`. posthog-js sent
  `$lib = 'web'` and the new sender may not, and the history includes `localhost` traffic.
- Once the history is closed and has no duplicate uuids, read it without `FINAL` (it blocked partition
  pruning: 820 → 370 ms), and give it the same typed columns as the live table
  ([schema.md](schema.md#typed-columns-for-hot-attributes)).

## Gotchas

- Self-hosting PostHog itself on Hexclave was tried first and dropped: its stack is too large
  (a deploy may declare at most 20 targets, and the builder ran out of disk on PostHog's image).
  ClickHouse plus an OTel collector covered every PostHog feature the site used, except the support chat
  widget. It stayed on posthog-js, loaded on click, until it was removed two weeks later.
- The trial left two detached volumes that keep billing and can't be deleted through the API. The
  ClickHouse and object-store services kept the trial's names so they reused its disks
  ([operations.md](operations.md#volumes-are-tied-to-the-group-and-service-id)).
- The PostHog MCP session can expire mid-export. Plan windows so any one of them can be re-run.

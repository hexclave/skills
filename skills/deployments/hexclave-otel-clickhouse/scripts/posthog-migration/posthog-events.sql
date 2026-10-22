-- PostHog Cloud history, loaded by import-posthog.py. Same shape as PostHog's events table, so
-- HogQL-era queries port with only the property syntax changed (properties['$host']).
CREATE DATABASE IF NOT EXISTS telemetry;

CREATE TABLE IF NOT EXISTS telemetry.posthog_events
(
    uuid String,
    event LowCardinality(String),
    distinct_id String,
    timestamp DateTime64(6, 'UTC'),
    properties Map(String, String) CODEC(ZSTD(3)),
    elements_chain String CODEC(ZSTD(3)),
    person_id String,
    session_id String MATERIALIZED properties['$session_id']
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (event, toDate(timestamp), uuid);

-- rrweb session replay index. Chunk blobs live in an S3-compatible bucket (object_key = bucket key)
-- or, with no bucket configured, in replay.chunk_blobs (object_key = 'clickhouse:<project>/<session>/<seq>.json.gz').
-- Placeholders rendered by scripts/setup.sh: __REPLAY_TTL_DAYS__ (default 30), __OTEL_HOT_DAYS__.
-- Idempotent (IF NOT EXISTS). See references/schema.md for the query patterns.

CREATE DATABASE IF NOT EXISTS replay;

-- One row per uploaded chunk (= one browser batch). (project_id, session_id, seq) is the identity;
-- client retries reuse the same seq, so ReplacingMergeTree collapses duplicates (newest received_at wins).
CREATE TABLE IF NOT EXISTS replay.chunks
(
    project_id        LowCardinality(String),
    session_id        UUID,
    seq               UInt32,
    batch_id          UUID,
    object_key        String,                       -- bucket key <prefix><project>/<session>/<seq 10 digits>.json.gz, or 'clickhouse:...'
    first_ts          DateTime64(3, 'UTC'),
    last_ts           DateTime64(3, 'UTC'),
    event_count       UInt32,
    bytes_gz          UInt32,
    has_full_snapshot UInt8,                        -- chunk contains an rrweb FullSnapshot (type 2): a seek point
    distinct_id       String,                       -- Hexclave user id / anonymous id, '' if unknown
    urls              Array(String),                -- hrefs seen in Meta events (type 4) in this chunk
    error_count       UInt32,                       -- custom events tagged "error"
    click_count       UInt32,                       -- MouseInteraction Click events
    trace_ids         Array(String),                -- 32-hex W3C trace ids linked to this chunk
    user_agent        String,
    received_at       DateTime64(3, 'UTC') DEFAULT now64(3),
    INDEX idx_trace_ids trace_ids TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_distinct distinct_id TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = ReplacingMergeTree(received_at)
PARTITION BY toDate(first_ts)
ORDER BY (project_id, session_id, seq)
TTL toDateTime(first_ts) + toIntervalDay(__OTEL_HOT_DAYS__) TO VOLUME 'cold',
    toDateTime(first_ts) + toIntervalDay(__REPLAY_TTL_DAYS__) DELETE
SETTINGS storage_policy = 'tiered', ttl_only_drop_parts = 1;

-- Session list/search table, maintained incrementally from chunks.
CREATE TABLE IF NOT EXISTS replay.sessions
(
    project_id   LowCardinality(String),
    session_id   UUID,
    start_ts     SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
    end_ts       SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
    distinct_id  SimpleAggregateFunction(anyLast, String),
    urls         SimpleAggregateFunction(groupUniqArrayArray, Array(String)),
    trace_ids    SimpleAggregateFunction(groupUniqArrayArray, Array(String)),
    chunk_count  SimpleAggregateFunction(sum, UInt64),
    event_count  SimpleAggregateFunction(sum, UInt64),
    bytes_gz     SimpleAggregateFunction(sum, UInt64),
    error_count  SimpleAggregateFunction(sum, UInt64),
    click_count  SimpleAggregateFunction(sum, UInt64),
    user_agent   SimpleAggregateFunction(anyLast, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(start_ts)
ORDER BY (project_id, session_id)
TTL toDateTime(start_ts) + toIntervalDay(__REPLAY_TTL_DAYS__) DELETE
SETTINGS storage_policy = 'tiered';

-- Note: retried chunks are counted twice in the sums until you query chunks FINAL; the
-- ingest service only inserts a chunk row after the blob write succeeds, so duplicates are rare.
CREATE MATERIALIZED VIEW IF NOT EXISTS replay.sessions_mv TO replay.sessions AS
SELECT
    project_id,
    session_id,
    first_ts                       AS start_ts,
    last_ts                        AS end_ts,
    distinct_id,
    urls,
    trace_ids,
    toUInt64(1)                    AS chunk_count,
    toUInt64(event_count)          AS event_count,
    toUInt64(bytes_gz)             AS bytes_gz,
    toUInt64(error_count)          AS error_count,
    toUInt64(click_count)          AS click_count,
    user_agent
FROM replay.chunks;

-- trace_id -> session lookup (the "open replay from a trace" path).
CREATE TABLE IF NOT EXISTS replay.trace_sessions
(
    trace_id   String,
    project_id LowCardinality(String),
    session_id UUID,
    ts         DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(ts)
ORDER BY (trace_id, project_id, session_id)
TTL toDateTime(ts) + toIntervalDay(__REPLAY_TTL_DAYS__) DELETE
SETTINGS storage_policy = 'tiered';

CREATE MATERIALIZED VIEW IF NOT EXISTS replay.trace_sessions_mv TO replay.trace_sessions AS
SELECT arrayJoin(trace_ids) AS trace_id, project_id, session_id, first_ts AS ts
FROM replay.chunks
WHERE notEmpty(trace_ids);

-- Gzipped chunk blobs when replay-ingest runs without a bucket (REPLAY_BLOB_STORE=clickhouse, the
-- default when no bucket credentials are set). The payload is already gzip, so ZSTD(1) only trims
-- headers; the point is one less moving part, not compression. Same retention as the index.
CREATE TABLE IF NOT EXISTS replay.chunk_blobs
(
    project_id  LowCardinality(String),
    session_id  UUID,
    seq         UInt32,
    first_ts    DateTime64(3, 'UTC'),
    blob        String CODEC(ZSTD(1)),
    received_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(received_at)
PARTITION BY toDate(first_ts)
ORDER BY (project_id, session_id, seq)
TTL toDateTime(first_ts) + toIntervalDay(__OTEL_HOT_DAYS__) TO VOLUME 'cold',
    toDateTime(first_ts) + toIntervalDay(__REPLAY_TTL_DAYS__) DELETE
SETTINGS storage_policy = 'tiered', ttl_only_drop_parts = 1;

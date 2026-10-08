-- OpenTelemetry tables for the clickhouse exporter (otelcol-contrib v0.162.0, create_schema: false).
-- Rendered from exporter/clickhouseexporter/internal/sqltemplates at tag v0.162.0. Column names and
-- types MUST stay identical to upstream so the exporter's INSERTs (and ClickStack/HyperDX) keep working.
-- Local changes vs upstream: database `otel`, tiered storage (TO VOLUME 'cold'), explicit storage_policy.
-- Placeholders rendered by scripts/setup.sh: __OTEL_HOT_DAYS__ (days on local NVMe), __OTEL_TTL_DAYS__ (total retention).
-- Idempotent: every statement is IF NOT EXISTS. Retention changes go through scripts/set-retention.sh.

CREATE DATABASE IF NOT EXISTS otel;

CREATE TABLE IF NOT EXISTS `otel`.`otel_logs` (
    `Timestamp` DateTime64(9) COMMENT 'Event timestamp with nanosecond precision' CODEC(Delta(8), ZSTD(1)),
    `TraceId` String COMMENT 'W3C trace identifier' CODEC(ZSTD(1)),
    `SpanId` String COMMENT 'W3C span identifier' CODEC(ZSTD(1)),
    `TraceFlags` UInt8 COMMENT 'W3C trace flags',
    `SeverityText` LowCardinality(String) COMMENT 'Log severity as text' CODEC(ZSTD(1)),
    `SeverityNumber` UInt8 COMMENT 'Log severity as number (1-24)',
    `ServiceName` LowCardinality(String) COMMENT 'Service that emitted the log' CODEC(ZSTD(1)),
    `Body` String COMMENT 'Log message body' CODEC(ZSTD(1)),
    `ResourceSchemaUrl` LowCardinality(String) COMMENT 'Schema URL for the resource' CODEC(ZSTD(1)),
    `ResourceAttributes` Map(LowCardinality(String), String) COMMENT 'Resource attributes as key-value pairs' CODEC(ZSTD(1)),
    `ScopeSchemaUrl` LowCardinality(String) COMMENT 'Schema URL for the instrumentation scope' CODEC(ZSTD(1)),
    `ScopeName` String COMMENT 'Instrumentation scope name' CODEC(ZSTD(1)),
    `ScopeVersion` LowCardinality(String) COMMENT 'Instrumentation scope version' CODEC(ZSTD(1)),
    `ScopeAttributes` Map(LowCardinality(String), String) COMMENT 'Instrumentation scope attributes' CODEC(ZSTD(1)),
    `LogAttributes` Map(LowCardinality(String), String) COMMENT 'Log record attributes' CODEC(ZSTD(1)),
    `EventName` String COMMENT 'Event name for log records representing events' CODEC(ZSTD(1)),
    `__otel_materialized_k8s.cluster.name` LowCardinality(String) MATERIALIZED ResourceAttributes['k8s.cluster.name'] CODEC(ZSTD(1)),
    `__otel_materialized_k8s.container.name` LowCardinality(String) MATERIALIZED ResourceAttributes['k8s.container.name'] CODEC(ZSTD(1)),
    `__otel_materialized_k8s.deployment.name` LowCardinality(String) MATERIALIZED ResourceAttributes['k8s.deployment.name'] CODEC(ZSTD(1)),
    `__otel_materialized_k8s.namespace.name` LowCardinality(String) MATERIALIZED ResourceAttributes['k8s.namespace.name'] CODEC(ZSTD(1)),
    `__otel_materialized_k8s.node.name` LowCardinality(String) MATERIALIZED ResourceAttributes['k8s.node.name'] CODEC(ZSTD(1)),
    `__otel_materialized_k8s.pod.name` LowCardinality(String) MATERIALIZED ResourceAttributes['k8s.pod.name'] CODEC(ZSTD(1)),
    `__otel_materialized_k8s.pod.uid` LowCardinality(String) MATERIALIZED ResourceAttributes['k8s.pod.uid'] CODEC(ZSTD(1)),
    `__otel_materialized_deployment.environment.name` LowCardinality(String) MATERIALIZED ResourceAttributes['deployment.environment.name'] CODEC(ZSTD(1)),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_log_attr_key mapKeys(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_log_attr_value mapValues(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_lower_body lower(Body) TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 8
) ENGINE = MergeTree()
PARTITION BY toDate(Timestamp)
ORDER BY (toStartOfFiveMinutes(Timestamp), ServiceName, Timestamp)
TTL toDateTime(Timestamp) + toIntervalDay(__OTEL_HOT_DAYS__) TO VOLUME 'cold',
    toDateTime(Timestamp) + toIntervalDay(__OTEL_TTL_DAYS__) DELETE
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1, storage_policy = 'tiered';

CREATE TABLE IF NOT EXISTS `otel`.`otel_traces` (
    Timestamp DateTime64(9) CODEC(Delta, ZSTD(1)),
    TraceId String CODEC(ZSTD(1)),
    SpanId String CODEC(ZSTD(1)),
    ParentSpanId String CODEC(ZSTD(1)),
    TraceState String CODEC(ZSTD(1)),
    SpanName LowCardinality(String) CODEC(ZSTD(1)),
    SpanKind LowCardinality(String) CODEC(ZSTD(1)),
    ServiceName LowCardinality(String) CODEC(ZSTD(1)),
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeName String CODEC(ZSTD(1)),
    ScopeVersion String CODEC(ZSTD(1)),
    SpanAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    Duration UInt64 CODEC(ZSTD(1)),
    StatusCode LowCardinality(String) CODEC(ZSTD(1)),
    StatusMessage String CODEC(ZSTD(1)),
    Events Nested (
        Timestamp DateTime64(9),
        Name LowCardinality(String),
        Attributes Map(LowCardinality(String), String)
    ) CODEC(ZSTD(1)),
    Links Nested (
        TraceId String,
        SpanId String,
        TraceState String,
        Attributes Map(LowCardinality(String), String)
    ) CODEC(ZSTD(1)),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_key mapKeys(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_value mapValues(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_duration Duration TYPE minmax GRANULARITY 1
) ENGINE = MergeTree()
PARTITION BY toDate(Timestamp)
ORDER BY (ServiceName, SpanName, toDateTime(Timestamp))
TTL toDateTime(Timestamp) + toIntervalDay(__OTEL_HOT_DAYS__) TO VOLUME 'cold',
    toDateTime(Timestamp) + toIntervalDay(__OTEL_TTL_DAYS__) DELETE
SETTINGS index_granularity=8192, ttl_only_drop_parts = 1, storage_policy = 'tiered';

CREATE TABLE IF NOT EXISTS "otel"."otel_traces_trace_id_ts"  (
    TraceId String CODEC(ZSTD(1)),
    Start DateTime CODEC(Delta, ZSTD(1)),
    End DateTime CODEC(Delta, ZSTD(1)),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.01) GRANULARITY 1
) ENGINE = MergeTree()
    PARTITION BY toDate(Start)
    ORDER BY (TraceId, Start)
    TTL toDateTime(Start) + toIntervalDay(__OTEL_HOT_DAYS__) TO VOLUME 'cold',
    toDateTime(Start) + toIntervalDay(__OTEL_TTL_DAYS__) DELETE
    SETTINGS index_granularity=8192, ttl_only_drop_parts = 1, storage_policy = 'tiered';

CREATE MATERIALIZED VIEW IF NOT EXISTS "otel"."otel_traces_trace_id_ts_mv" 
TO "otel"."otel_traces_trace_id_ts"
AS SELECT
              TraceId,
              min(Timestamp) as Start,
              max(Timestamp) as End
   FROM "otel"."otel_traces"
   WHERE TraceId != ''
   GROUP BY TraceId;

CREATE TABLE IF NOT EXISTS `otel`.`otel_metrics_gauge` (
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ResourceSchemaUrl String CODEC(ZSTD(1)),
    ScopeName String CODEC(ZSTD(1)),
    ScopeVersion String CODEC(ZSTD(1)),
    ScopeAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeDroppedAttrCount UInt32 CODEC(ZSTD(1)),
    ScopeSchemaUrl String CODEC(ZSTD(1)),
    ServiceName LowCardinality(String) CODEC(ZSTD(1)),
    MetricName LowCardinality(String) CODEC(ZSTD(1)),
    MetricDescription String CODEC(ZSTD(1)),
    MetricUnit String CODEC(ZSTD(1)),
    Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    StartTimeUnix DateTime CODEC(Delta, ZSTD(1)),
    TimeUnix DateTime CODEC(Delta, ZSTD(1)),
    Value Float64 CODEC(ZSTD(1)),
    Flags UInt32 CODEC(ZSTD(1)),
    Exemplars Nested (
        FilteredAttributes Map(LowCardinality(String), String),
        TimeUnix DateTime,
        Value Float64,
        SpanId String,
        TraceId String
    ) CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_time_minmax TimeUnix TYPE minmax GRANULARITY 1
    ) ENGINE = MergeTree()
    PARTITION BY toDate(TimeUnix)
    ORDER BY (ServiceName, MetricName, toStartOfHour(TimeUnix), cityHash64(Attributes), TimeUnix)
    TTL TimeUnix + toIntervalDay(__OTEL_HOT_DAYS__) TO VOLUME 'cold',
    TimeUnix + toIntervalDay(__OTEL_TTL_DAYS__) DELETE
    SETTINGS index_granularity=8192, ttl_only_drop_parts = 1, storage_policy = 'tiered';

CREATE TABLE IF NOT EXISTS `otel`.`otel_metrics_sum` (
                                     ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ResourceSchemaUrl String CODEC(ZSTD(1)),
    ScopeName String CODEC(ZSTD(1)),
    ScopeVersion String CODEC(ZSTD(1)),
    ScopeAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeDroppedAttrCount UInt32 CODEC(ZSTD(1)),
    ScopeSchemaUrl String CODEC(ZSTD(1)),
    ServiceName LowCardinality(String) CODEC(ZSTD(1)),
    MetricName LowCardinality(String) CODEC(ZSTD(1)),
    MetricDescription String CODEC(ZSTD(1)),
    MetricUnit String CODEC(ZSTD(1)),
    Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    StartTimeUnix DateTime CODEC(Delta, ZSTD(1)),
    TimeUnix DateTime CODEC(Delta, ZSTD(1)),
    Value Float64 CODEC(ZSTD(1)),
    Flags UInt32  CODEC(ZSTD(1)),
    Exemplars Nested (
                         FilteredAttributes Map(LowCardinality(String), String),
    TimeUnix DateTime,
    Value Float64,
    SpanId String,
    TraceId String
    ) CODEC(ZSTD(1)),
    AggregationTemporality Int32 CODEC(ZSTD(1)),
    IsMonotonic Boolean CODEC(Delta, ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_time_minmax TimeUnix TYPE minmax GRANULARITY 1
    ) ENGINE = MergeTree()
    PARTITION BY toDate(TimeUnix)
    ORDER BY (ServiceName, MetricName, toStartOfHour(TimeUnix), cityHash64(Attributes), TimeUnix)
    TTL TimeUnix + toIntervalDay(__OTEL_HOT_DAYS__) TO VOLUME 'cold',
    TimeUnix + toIntervalDay(__OTEL_TTL_DAYS__) DELETE
    SETTINGS index_granularity=8192, ttl_only_drop_parts = 1, storage_policy = 'tiered';

CREATE TABLE IF NOT EXISTS `otel`.`otel_metrics_histogram` (
                                     ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ResourceSchemaUrl String CODEC(ZSTD(1)),
    ScopeName String CODEC(ZSTD(1)),
    ScopeVersion String CODEC(ZSTD(1)),
    ScopeAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeDroppedAttrCount UInt32 CODEC(ZSTD(1)),
    ScopeSchemaUrl String CODEC(ZSTD(1)),
    ServiceName LowCardinality(String) CODEC(ZSTD(1)),
    MetricName LowCardinality(String) CODEC(ZSTD(1)),
    MetricDescription String CODEC(ZSTD(1)),
    MetricUnit String CODEC(ZSTD(1)),
    Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    StartTimeUnix DateTime CODEC(Delta, ZSTD(1)),
    TimeUnix DateTime CODEC(Delta, ZSTD(1)),
    Count UInt64 CODEC(Delta, ZSTD(1)),
    Sum Float64 CODEC(ZSTD(1)),
    BucketCounts Array(UInt64) CODEC(ZSTD(1)),
    ExplicitBounds Array(Float64) CODEC(ZSTD(1)),
    Exemplars Nested (
                         FilteredAttributes Map(LowCardinality(String), String),
    TimeUnix DateTime,
    Value Float64,
    SpanId String,
    TraceId String
    ) CODEC(ZSTD(1)),
    Flags UInt32 CODEC(ZSTD(1)),
    Min Float64 CODEC(ZSTD(1)),
    Max Float64 CODEC(ZSTD(1)),
    AggregationTemporality Int32 CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_time_minmax TimeUnix TYPE minmax GRANULARITY 1
    ) ENGINE = MergeTree()
    PARTITION BY toDate(TimeUnix)
    ORDER BY (ServiceName, MetricName, toStartOfHour(TimeUnix), cityHash64(Attributes), TimeUnix)
    TTL TimeUnix + toIntervalDay(__OTEL_HOT_DAYS__) TO VOLUME 'cold',
    TimeUnix + toIntervalDay(__OTEL_TTL_DAYS__) DELETE
    SETTINGS index_granularity=8192, ttl_only_drop_parts = 1, storage_policy = 'tiered';

CREATE TABLE IF NOT EXISTS `otel`.`otel_metrics_summary` (
                                     ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ResourceSchemaUrl String CODEC(ZSTD(1)),
    ScopeName String CODEC(ZSTD(1)),
    ScopeVersion String CODEC(ZSTD(1)),
    ScopeAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeDroppedAttrCount UInt32 CODEC(ZSTD(1)),
    ScopeSchemaUrl String CODEC(ZSTD(1)),
    ServiceName LowCardinality(String) CODEC(ZSTD(1)),
    MetricName LowCardinality(String) CODEC(ZSTD(1)),
    MetricDescription String CODEC(ZSTD(1)),
    MetricUnit String CODEC(ZSTD(1)),
    Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    StartTimeUnix DateTime CODEC(Delta, ZSTD(1)),
    TimeUnix DateTime CODEC(Delta, ZSTD(1)),
    Count UInt64 CODEC(Delta, ZSTD(1)),
    Sum Float64 CODEC(ZSTD(1)),
    ValueAtQuantiles Nested(
                               Quantile Float64,
                               Value Float64
                           ) CODEC(ZSTD(1)),
    Flags UInt32  CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_time_minmax TimeUnix TYPE minmax GRANULARITY 1
    ) ENGINE = MergeTree()
    PARTITION BY toDate(TimeUnix)
    ORDER BY (ServiceName, MetricName, toStartOfHour(TimeUnix), cityHash64(Attributes), TimeUnix)
    TTL TimeUnix + toIntervalDay(__OTEL_HOT_DAYS__) TO VOLUME 'cold',
    TimeUnix + toIntervalDay(__OTEL_TTL_DAYS__) DELETE
    SETTINGS index_granularity=8192, ttl_only_drop_parts = 1, storage_policy = 'tiered';

CREATE TABLE IF NOT EXISTS `otel`.`otel_metrics_exp_histogram` (
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ResourceSchemaUrl String CODEC(ZSTD(1)),
    ScopeName String CODEC(ZSTD(1)),
    ScopeVersion String CODEC(ZSTD(1)),
    ScopeAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeDroppedAttrCount UInt32 CODEC(ZSTD(1)),
    ScopeSchemaUrl String CODEC(ZSTD(1)),
    ServiceName LowCardinality(String) CODEC(ZSTD(1)),
    MetricName LowCardinality(String) CODEC(ZSTD(1)),
    MetricDescription String CODEC(ZSTD(1)),
    MetricUnit String CODEC(ZSTD(1)),
    Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    StartTimeUnix DateTime CODEC(Delta, ZSTD(1)),
    TimeUnix DateTime CODEC(Delta, ZSTD(1)),
    Count UInt64 CODEC(Delta, ZSTD(1)),
    Sum Float64 CODEC(ZSTD(1)),
    Scale Int32 CODEC(ZSTD(1)),
    ZeroCount UInt64 CODEC(ZSTD(1)),
    PositiveOffset Int32 CODEC(ZSTD(1)),
    PositiveBucketCounts Array(UInt64) CODEC(ZSTD(1)),
    NegativeOffset Int32 CODEC(ZSTD(1)),
    NegativeBucketCounts Array(UInt64) CODEC(ZSTD(1)),
    Exemplars Nested (
        FilteredAttributes Map(LowCardinality(String), String),
        TimeUnix DateTime,
        Value Float64,
        SpanId String,
        TraceId String
    ) CODEC(ZSTD(1)),
    Flags UInt32  CODEC(ZSTD(1)),
    Min Float64 CODEC(ZSTD(1)),
    Max Float64 CODEC(ZSTD(1)),
    AggregationTemporality Int32 CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_time_minmax TimeUnix TYPE minmax GRANULARITY 1
    ) ENGINE = MergeTree()
    PARTITION BY toDate(TimeUnix)
    ORDER BY (ServiceName, MetricName, toStartOfHour(TimeUnix), cityHash64(Attributes), TimeUnix)
    TTL TimeUnix + toIntervalDay(__OTEL_HOT_DAYS__) TO VOLUME 'cold',
    TimeUnix + toIntervalDay(__OTEL_TTL_DAYS__) DELETE
    SETTINGS index_granularity=8192, ttl_only_drop_parts = 1, storage_policy = 'tiered';

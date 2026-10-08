// Hexclave Deployments spec for the observability stack: ClickHouse + OTel gateway + rrweb replay
// ingest, on Hexclave's default runtime. scripts/hexclave-deploy.sh copies this file to the root
// of an assembled deploy directory and runs `hexclave deploy` there (paths are relative to it).
//
// Storage is chosen by env at deploy time, so the stack runs with no bucket at all:
//   ClickHouse  CH_S3_ENDPOINT unset -> one 500GB volume, TTL delete only
//               CH_S3_ENDPOINT set   -> hot volume + S3-compatible bucket (GCS, R2, S3, ...)
//   Replay      REPLAY_BUCKET unset  -> gzipped chunks in ClickHouse (replay.chunk_blobs)
//               REPLAY_BUCKET set    -> gzipped chunks in that bucket
//
// Secrets: secret(KEY, fallback) uses a value stored under Project Settings > Secrets first, else
// the same-named env var of the deploying shell (sent with the request, never stored).
import type { HexclaveDeploymentConfig } from "@hexclave/js";

export const deploymentGroupId = "observability";

const env = (key: string, fallback: string) => process.env[key] ?? fallback;
const chS3 = Boolean(process.env.CH_S3_ENDPOINT) || process.env.CH_STORAGE === "s3";
const replayS3 = Boolean(process.env.REPLAY_BUCKET) || process.env.REPLAY_BLOB_STORE === "s3";
// "Pause": Hexclave has no tenant-facing stop/park call, so pausing = redeploying with every floor at 0.
// Machines then stop (serverless) or suspend/stop (server) when idle and the volume is kept, BUT the
// runtime autostarts them on the next request, so a paused stack still wakes up if something calls it.
const scaleToZero = process.env.OBS_SCALE_TO_ZERO === "1";

export const deploy: HexclaveDeploymentConfig = ({ isDev, secret, service }) => {
  const s = (key: string) => secret(key, process.env[key]);
  const chStorageEnv = chS3 ? {
    CH_S3_ENDPOINT: s("CH_S3_ENDPOINT"), // https://<host>/<bucket>/<prefix>/ (path-style, trailing slash)
    CH_S3_REGION: env("CH_S3_REGION", "auto"),
    CH_S3_BATCH_DELETE: env("CH_S3_BATCH_DELETE", "true"), // "false" for GCS (no S3 DeleteObjects)
    AWS_ACCESS_KEY_ID: s("CH_S3_ACCESS_KEY_ID"),
    AWS_SECRET_ACCESS_KEY: s("CH_S3_SECRET_ACCESS_KEY"),
    CH_S3_CACHE_SIZE: env("CH_S3_CACHE_SIZE", "200Gi"), // must leave room for the hot tier on the volume
  } : {};
  const replayStorageEnv = replayS3 ? {
    REPLAY_BLOB_STORE: "s3",
    AWS_ENDPOINT_URL_S3: env("REPLAY_S3_ENDPOINT", "https://storage.googleapis.com"),
    AWS_REGION: env("REPLAY_S3_REGION", "auto"),
    BUCKET_NAME: env("REPLAY_BUCKET", "hexclave-obs-replays"),
    AWS_ACCESS_KEY_ID: s("REPLAY_S3_ACCESS_KEY_ID"),
    AWS_SECRET_ACCESS_KEY: s("REPLAY_S3_SECRET_ACCESS_KEY"),
  } : { REPLAY_BLOB_STORE: "clickhouse" };

  return {
    services: {
      clickhouse: {
        type: "server", // single instance with the one allowed volume; minInstances 1 = never suspended (paid plan)
        public: false, // private: raw TCP is only allowed on private services
        ports: {
          8123: { protocol: "http" }, // HTTP interface (replay-ingest)
          9000: { protocol: "tcp" }, // native protocol (OTel clickhouse exporter)
        },
        memory: "8GB", // platform ceiling for a server: 2 dedicated ("performance") CPUs
        minInstances: scaleToZero ? 0 : 1,
        rootDirectory: ".",
        dockerfilePath: "hexclave/clickhouse/Dockerfile",
        persistentVolumes: {
          chdata: { path: "/data", sizeGb: Number(env("CH_VOLUME_GB", "500")) }, // 1..500; data, tmp, (cache)
        },
        env: {
          ...(isDev ? {} : chStorageEnv),
          CLICKHOUSE_ADMIN_PASSWORD: isDev ? null : s("CLICKHOUSE_ADMIN_PASSWORD"),
          CLICKHOUSE_OTEL_PASSWORD: isDev ? null : s("CLICKHOUSE_OTEL_PASSWORD"),
          CLICKHOUSE_REPLAY_PASSWORD: isDev ? null : s("CLICKHOUSE_REPLAY_PASSWORD"),
          CLICKHOUSE_READER_PASSWORD: isDev ? null : s("CLICKHOUSE_READER_PASSWORD"),
          OTEL_HOT_DAYS: env("OTEL_HOT_DAYS", "1"), // only used with a bucket
          OTEL_TTL_DAYS: env("OTEL_TTL_DAYS", "30"),
          REPLAY_TTL_DAYS: env("REPLAY_TTL_DAYS", env("OTEL_TTL_DAYS", "30")),
        },
      },

      "otel-gateway": {
        // min == max keeps the machines running (never autostopped), so the exporter's queue keeps
        // draining; the file queue lives on the machine's root filesystem (lost on replacement).
        type: "serverless",
        public: true,
        ports: { 4318: { protocol: "http" } }, // OTLP/HTTP only: the public edge does not carry gRPC
        memory: "2GB",
        minInstances: scaleToZero ? 0 : Number(env("OTEL_GATEWAY_INSTANCES", "2")),
        maxInstances: Number(env("OTEL_GATEWAY_INSTANCES", "2")),
        rootDirectory: ".",
        dockerfilePath: "hexclave/gateway/Dockerfile",
        env: {
          CLICKHOUSE_HOST: isDev ? "127.0.0.1" : service("clickhouse").hostname(),
          CLICKHOUSE_NATIVE_PORT: "9000",
          CLICKHOUSE_OTEL_PASSWORD: isDev ? null : s("CLICKHOUSE_OTEL_PASSWORD"),
          OTEL_INGEST_TOKENS: isDev ? null : s("OTEL_INGEST_TOKENS"), // comma-separated bearer tokens
          OTEL_QUEUE_STORAGE: env("OTEL_QUEUE_STORAGE", "file"),
        },
      },

      "replay-ingest": {
        type: "serverless",
        public: true,
        ports: { 8080: { protocol: "http" } },
        memory: "1GB",
        minInstances: scaleToZero ? 0 : Number(env("REPLAY_MIN_INSTANCES", "1")),
        maxInstances: Number(env("REPLAY_MAX_INSTANCES", "4")),
        rootDirectory: ".", // the builder's context is always the upload root
        dockerfilePath: "hexclave/replay-ingest/Dockerfile",
        env: {
          ...replayStorageEnv,
          CLICKHOUSE_URL: isDev ? "http://127.0.0.1:8123" : service("clickhouse").url(8123),
          CLICKHOUSE_USER: "replay_rw",
          CLICKHOUSE_REPLAY_PASSWORD: isDev ? null : s("CLICKHOUSE_REPLAY_PASSWORD"),
          CLICKHOUSE_READER_PASSWORD: isDev ? null : s("CLICKHOUSE_READER_PASSWORD"), // enables GET /v1/otel/summary
          REPLAY_WRITE_KEYS: isDev ? null : s("REPLAY_WRITE_KEYS"), // "project:publicKey,..."
          REPLAY_READ_TOKEN: isDev ? null : s("REPLAY_READ_TOKEN"),
          REPLAY_ALLOWED_ORIGINS: env("REPLAY_ALLOWED_ORIGINS", "*"),
        },
      },
    },
  };
};

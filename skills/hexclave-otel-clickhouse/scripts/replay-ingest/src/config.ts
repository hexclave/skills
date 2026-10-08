// All configuration is environment variables (Hexclave service env / secrets). Fails fast on missing values.

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`replay-ingest: missing required env var ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

/** "projA:key1,projB:key2" -> Map(key -> project). Write keys are public (they ship in page JS). */
function parseWriteKeys(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const idx = pair.indexOf(":");
    if (idx <= 0 || idx === pair.length - 1) throw new Error(`REPLAY_WRITE_KEYS entry must be project:key, got ${JSON.stringify(pair)}`);
    const project = pair.slice(0, idx);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(project)) throw new Error(`invalid project id in REPLAY_WRITE_KEYS: ${project}`);
    map.set(pair.slice(idx + 1), project);
  }
  if (map.size === 0) throw new Error("REPLAY_WRITE_KEYS is empty");
  return map;
}

function blobStore(): "s3" | "clickhouse" {
  const forced = process.env.REPLAY_BLOB_STORE?.trim();
  if (forced === "s3" || forced === "clickhouse") return forced;
  if (forced) throw new Error(`REPLAY_BLOB_STORE must be s3 or clickhouse, got ${JSON.stringify(forced)}`);
  return process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.BUCKET_NAME?.trim() ? "s3" : "clickhouse";
}

export const config = {
  port: Number(optional("PORT", "8080")),
  writeKeys: parseWriteKeys(required("REPLAY_WRITE_KEYS")),
  readToken: required("REPLAY_READ_TOKEN"),
  allowedOrigins: optional("REPLAY_ALLOWED_ORIGINS", "*").split(",").map((s) => s.trim()).filter(Boolean),
  // Where gzipped chunk blobs go. "s3" (any S3-compatible bucket) when bucket credentials are set,
  // else "clickhouse" (replay.chunk_blobs, String CODEC(ZSTD), same TTL). Force with REPLAY_BLOB_STORE.
  blobStore: blobStore(),
  s3: blobStore() === "s3" ? {
    endpoint: required("AWS_ENDPOINT_URL_S3"), // e.g. https://storage.googleapis.com, https://<acct>.r2.cloudflarestorage.com
    region: optional("AWS_REGION", "auto"),
    accessKeyId: required("AWS_ACCESS_KEY_ID"),
    secretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
    bucket: required("BUCKET_NAME"),
    prefix: optional("REPLAY_S3_PREFIX", "replays/"),
  } : null,
  clickhouse: {
    url: optional("CLICKHOUSE_URL", "http://localhost:8123").replace(/\/$/, ""),
    user: optional("CLICKHOUSE_USER", "replay_rw"),
    password: required("CLICKHOUSE_REPLAY_PASSWORD"),
    // Optional read-only user for GET /v1/otel/summary (verification / smoke checks).
    readerUser: optional("CLICKHOUSE_READER_USER", "reader"),
    readerPassword: process.env.CLICKHOUSE_READER_PASSWORD?.trim() || null,
  },
  limits: {
    maxBodyBytes: Number(optional("REPLAY_MAX_BODY_BYTES", String(1_000_000))),
    maxDecompressedBytes: Number(optional("REPLAY_MAX_DECOMPRESSED_BYTES", String(8 * 1024 * 1024))),
    maxEvents: Number(optional("REPLAY_MAX_EVENTS", "5000")),
  },
} as const;

// rrweb session replay ingest + read API.
//   POST /v1/replay/batch           browser -> gzipped/JSON batch -> blob (S3 bucket or ClickHouse) + index row
//   GET  /v1/replay/sessions        list/search sessions (read token)
//   GET  /v1/replay/sessions/:project/:session/events   ordered rrweb events as one JSON array (streamed)
//   GET  /v1/replay/by-trace/:traceId                   sessions linked to a W3C trace id
//   GET  /player/:project/:session  minimal rrweb-player page (token in URL fragment, never sent to server logs)
//   GET  /v1/otel/summary           row counts per OTel table/service for the last N minutes (read token;
//                                   needs CLICKHOUSE_READER_PASSWORD). For smoke tests, not a query API.
//   GET  /healthz
import { S3Client } from "bun";
import { gunzipSync, gzipSync } from "node:zlib";
import { chGetBlob, chInsertJSONEachRow, chPutBlob, chQuery } from "./clickhouse";
import { config } from "./config";
import { BadRequest, extractMeta, isTraceId, isUuid, objectKey, parseBatch } from "./events";
import { playerHtml } from "./player";

const s3 = config.s3 === null ? null : new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  accessKeyId: config.s3.accessKeyId,
  secretAccessKey: config.s3.secretAccessKey,
  bucket: config.s3.bucket,
});
// object_key of a chunk stored in replay.chunk_blobs. Reads dispatch on the prefix, so switching a
// deployment from ClickHouse blobs to a bucket later keeps old sessions playable.
const CH_BLOB_PREFIX = "clickhouse:";

const PROJECT_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin) return {};
  const allowed = config.allowedOrigins.includes("*") || config.allowedOrigins.includes(origin);
  if (!allowed) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Replay-Key",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

/** Write keys may arrive as a header or as ?key= (sendBeacon cannot set headers). */
function projectForWriteKey(req: Request, url: URL): string | null {
  const key = req.headers.get("x-replay-key") ?? bearer(req) ?? url.searchParams.get("key");
  return key ? config.writeKeys.get(key) ?? null : null;
}

function requireRead(req: Request): Response | null {
  const token = bearer(req);
  if (!token || token.length !== config.readToken.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(config.readToken))) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

/** Bodies are gzip (detected by magic bytes, since sendBeacon cannot set Content-Encoding) or plain JSON. */
function decodeBody(bytes: Uint8Array): unknown {
  if (bytes.byteLength > config.limits.maxBodyBytes) throw Object.assign(new BadRequest("body too large"), { status: 413 });
  let text: string;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      text = gunzipSync(bytes, { maxOutputLength: config.limits.maxDecompressedBytes }).toString("utf8");
    } catch {
      throw Object.assign(new BadRequest("invalid or oversized gzip body"), { status: 413 });
    }
  } else {
    text = new TextDecoder().decode(bytes);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest("body is not valid JSON");
  }
}

async function handleBatch(req: Request, url: URL): Promise<Response> {
  const cors = corsHeaders(req);
  const project = projectForWriteKey(req, url);
  if (!project) return json({ error: "invalid write key" }, 401, cors);

  const bytes = new Uint8Array(await req.arrayBuffer());
  const batch = parseBatch(decodeBody(bytes), config.limits.maxEvents);
  const meta = extractMeta(batch.events, batch.sent_at_ms, batch.trace_ids);
  const blob = gzipSync(JSON.stringify(batch.events), { level: 6 });
  const firstTsIso = new Date(meta.firstTs).toISOString();

  // Blob first, index second: an index row never points at a missing object. A retry rewrites both
  // (same key, ReplacingMergeTree collapses the rows).
  let key: string;
  if (s3 !== null && config.s3 !== null) {
    key = objectKey(config.s3.prefix, project, batch.session_id, batch.seq);
    await s3.write(key, blob, { type: "application/gzip" });
  } else {
    key = CH_BLOB_PREFIX + objectKey("", project, batch.session_id, batch.seq);
    await chPutBlob({ project, sessionId: batch.session_id, seq: batch.seq }, firstTsIso, blob);
  }
  await chInsertJSONEachRow("replay.chunks", [
    {
      project_id: project,
      session_id: batch.session_id,
      seq: batch.seq,
      batch_id: batch.batch_id,
      object_key: key,
      first_ts: firstTsIso,
      last_ts: new Date(meta.lastTs).toISOString(),
      event_count: batch.events.length,
      bytes_gz: blob.byteLength,
      has_full_snapshot: meta.hasFullSnapshot ? 1 : 0,
      distinct_id: batch.distinct_id,
      urls: meta.urls,
      error_count: meta.errorCount,
      click_count: meta.clickCount,
      trace_ids: meta.traceIds,
      user_agent: (req.headers.get("user-agent") ?? "").slice(0, 512),
    },
  ]);
  return json({ ok: true, session_id: batch.session_id, seq: batch.seq, object_key: key }, 200, cors);
}

type SessionRow = Record<string, unknown>;

async function listSessions(url: URL): Promise<Response> {
  const project = url.searchParams.get("project") ?? "";
  if (!PROJECT_RE.test(project)) return json({ error: "project is required" }, 400);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 500);
  const distinctId = url.searchParams.get("distinct_id") ?? "";
  // Output aliases must not reuse column names: ClickHouse resolves aliases before columns,
  // even inside subqueries (ILLEGAL_AGGREGATION otherwise). A session matches distinct_id if
  // ANY of its chunks carried it (early anonymous chunks still count toward the totals).
  const rows = await chQuery<SessionRow>(
    `SELECT project_id, session_id, min(start_ts) AS started_at, max(end_ts) AS ended_at,
            anyLast(distinct_id) AS user_id, groupUniqArrayArray(urls) AS pages,
            groupUniqArrayArray(trace_ids) AS traces, sum(chunk_count) AS chunks,
            sum(event_count) AS events, sum(error_count) AS errors, sum(click_count) AS clicks
     FROM replay.sessions
     WHERE project_id = {project:String}
       AND ({distinct_id:String} = '' OR session_id IN (
             SELECT s.session_id FROM replay.sessions AS s
             WHERE s.project_id = {project:String} AND s.distinct_id = {distinct_id:String}))
     GROUP BY project_id, session_id
     ORDER BY started_at DESC
     LIMIT {limit:UInt32}`,
    { project, distinct_id: distinctId, limit },
  );
  return json({ sessions: rows });
}

async function sessionsByTrace(traceId: string): Promise<Response> {
  if (!isTraceId(traceId)) return json({ error: "trace id must be 32 lowercase hex chars" }, 400);
  const rows = await chQuery<SessionRow>(
    `SELECT DISTINCT project_id, session_id, min(ts) AS first_seen
     FROM replay.trace_sessions WHERE trace_id = {trace_id:String}
     GROUP BY project_id, session_id ORDER BY first_seen`,
    { trace_id: traceId },
  );
  return json({ sessions: rows });
}

/** Streams `[e1,e2,...]` across all chunks in seq order without buffering the whole session. */
async function streamEvents(project: string, sessionId: string): Promise<Response> {
  if (!PROJECT_RE.test(project) || !isUuid(sessionId)) return json({ error: "bad project or session id" }, 400);
  const chunks = await chQuery<{ seq: number; object_key: string }>(
    `SELECT seq, object_key FROM replay.chunks FINAL
     WHERE project_id = {project:String} AND session_id = {session:UUID}
     ORDER BY seq`,
    { project, session: sessionId },
  );
  if (chunks.length === 0) return json({ error: "session not found" }, 404);

  const encoder = new TextEncoder();
  const fetchChunk = async (key: string, seq: number): Promise<string> => {
    let gz: Uint8Array;
    if (key.startsWith(CH_BLOB_PREFIX)) gz = await chGetBlob({ project, sessionId, seq });
    else if (s3 !== null) gz = await s3.file(key).bytes();
    else throw new Error(`chunk ${key} is in a bucket but no bucket is configured`);
    const text = gunzipSync(gz).toString("utf8").trim(); // "[...]"
    return text.slice(1, -1).trim();
  };
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode("["));
        let first = true;
        // Prefetch one chunk ahead so S3 latency overlaps with streaming.
        let next: Promise<string> | null = fetchChunk(chunks[0]!.object_key, chunks[0]!.seq);
        for (let i = 0; i < chunks.length; i++) {
          const current: string = await next!;
          next = i + 1 < chunks.length ? fetchChunk(chunks[i + 1]!.object_key, chunks[i + 1]!.seq) : null;
          if (current.length === 0) continue;
          controller.enqueue(encoder.encode((first ? "" : ",") + current));
          first = false;
        }
        controller.enqueue(encoder.encode("]"));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=60" } });
}

/** Smoke-test view of OTel ingest: rows per table and service in the last N minutes. */
async function otelSummary(url: URL): Promise<Response> {
  if (config.clickhouse.readerPassword === null) return json({ error: "CLICKHOUSE_READER_PASSWORD is not set" }, 404);
  const minutes = Math.min(Math.max(Number(url.searchParams.get("minutes") ?? 60) || 60, 1), 1440);
  const service = url.searchParams.get("service") ?? "";
  const q = (table: string, ts: string) => `SELECT '${table}' AS table, ServiceName AS service, count() AS rows
    FROM otel.${table} WHERE ${ts} >= now() - toIntervalMinute({minutes:UInt32})
      AND ({service:String} = '' OR ServiceName = {service:String}) GROUP BY ServiceName`;
  const sql = [
    q("otel_traces", "Timestamp"), q("otel_logs", "Timestamp"), q("otel_metrics_sum", "TimeUnix"),
    q("otel_metrics_gauge", "TimeUnix"), q("otel_metrics_histogram", "TimeUnix"),
  ].join(" UNION ALL ") + " ORDER BY table, service";
  const rows = await chQuery<Record<string, unknown>>(sql, { minutes, service }, { reader: true });
  return json({ minutes, service: service || null, rows });
}

const server = Bun.serve({
  port: config.port,
  hostname: "::",
  maxRequestBodySize: config.limits.maxBodyBytes + 1024,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
      if (path === "/healthz") return new Response("ok");
      if (req.method === "POST" && path === "/v1/replay/batch") return await handleBatch(req, url);

      if (req.method === "GET" && path.startsWith("/player/")) {
        const [, , project, session] = path.split("/");
        if (!project || !session || !PROJECT_RE.test(project) || !isUuid(session)) return json({ error: "bad path" }, 400);
        return new Response(playerHtml(project, session), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (req.method === "GET" && path === "/v1/otel/summary") {
        const denied = requireRead(req);
        if (denied) return denied;
        return await otelSummary(url);
      }

      if (req.method === "GET" && path.startsWith("/v1/replay/")) {
        const denied = requireRead(req);
        if (denied) return denied;
        if (path === "/v1/replay/sessions") return await listSessions(url);
        const byTrace = path.match(/^\/v1\/replay\/by-trace\/([^/]+)$/);
        if (byTrace) return await sessionsByTrace(byTrace[1]!);
        const ev = path.match(/^\/v1\/replay\/sessions\/([^/]+)\/([^/]+)\/events$/);
        if (ev) return await streamEvents(ev[1]!, ev[2]!.toLowerCase());
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      if (status >= 500) console.error("replay-ingest error", err);
      return json({ error: status >= 500 ? "internal error" : (err as Error).message }, status, corsHeaders(req));
    }
  },
});

console.log(`replay-ingest listening on [${server.hostname}]:${server.port}, blobs in ${config.blobStore}`);

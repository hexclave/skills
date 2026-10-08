// Pure helpers: payload validation and rrweb metadata extraction. No I/O.

// rrweb EventType enum values (from @rrweb/types): 2 FullSnapshot, 3 IncrementalSnapshot, 4 Meta, 5 Custom.
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;
const CUSTOM = 5;
// IncrementalSource.MouseInteraction = 2, MouseInteractions.Click = 2
const SOURCE_MOUSE_INTERACTION = 2;
const MOUSE_CLICK = 2;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;

export type BatchPayload = {
  session_id: string;
  seq: number;
  batch_id: string;
  distinct_id: string;
  sent_at_ms: number;
  trace_ids: string[];
  events: unknown[];
};

export class BadRequest extends Error {
  status = 400;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseBatch(body: unknown, maxEvents: number): BatchPayload {
  const b = asRecord(body);
  if (!b) throw new BadRequest("body must be a JSON object");
  const sessionId = String(b.session_id ?? "");
  const batchId = String(b.batch_id ?? "");
  if (!UUID_RE.test(sessionId)) throw new BadRequest("session_id must be a UUID");
  if (!UUID_RE.test(batchId)) throw new BadRequest("batch_id must be a UUID");
  const seq = Number(b.seq);
  if (!Number.isInteger(seq) || seq < 0 || seq > 4_000_000_000) throw new BadRequest("seq must be a non-negative integer");
  if (!Array.isArray(b.events) || b.events.length === 0) throw new BadRequest("events must be a non-empty array");
  if (b.events.length > maxEvents) throw new BadRequest(`too many events (max ${maxEvents})`);
  const distinctId = typeof b.distinct_id === "string" ? b.distinct_id.slice(0, 256) : "";
  const traceIds = Array.isArray(b.trace_ids)
    ? b.trace_ids.filter((t): t is string => typeof t === "string" && TRACE_ID_RE.test(t)).slice(0, 500)
    : [];
  const sentAt = Number(b.sent_at_ms);
  return {
    session_id: sessionId.toLowerCase(),
    seq,
    batch_id: batchId.toLowerCase(),
    distinct_id: distinctId,
    sent_at_ms: Number.isFinite(sentAt) ? sentAt : Date.now(),
    trace_ids: traceIds,
    events: b.events,
  };
}

export type ChunkMeta = {
  firstTs: number;
  lastTs: number;
  hasFullSnapshot: boolean;
  urls: string[];
  errorCount: number;
  clickCount: number;
  traceIds: string[];
};

export function extractMeta(events: unknown[], fallbackTs: number, clientTraceIds: string[]): ChunkMeta {
  let firstTs = Infinity;
  let lastTs = -Infinity;
  let hasFullSnapshot = false;
  let errorCount = 0;
  let clickCount = 0;
  const urls = new Set<string>();
  const traceIds = new Set<string>(clientTraceIds);

  for (const raw of events) {
    const e = asRecord(raw);
    if (!e) continue;
    const ts = e.timestamp;
    if (typeof ts === "number" && Number.isFinite(ts)) {
      if (ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;
    }
    const data = asRecord(e.data);
    switch (e.type) {
      case FULL_SNAPSHOT:
        hasFullSnapshot = true;
        break;
      case META:
        if (data && typeof data.href === "string") urls.add(data.href.slice(0, 2048));
        break;
      case INCREMENTAL:
        if (data && data.source === SOURCE_MOUSE_INTERACTION && data.type === MOUSE_CLICK) clickCount++;
        break;
      case CUSTOM: {
        const tag = data?.tag;
        const payload = asRecord(data?.payload);
        if (tag === "error") errorCount++;
        if (tag === "trace" && payload && typeof payload.traceId === "string" && TRACE_ID_RE.test(payload.traceId)) {
          traceIds.add(payload.traceId);
        }
        if (tag === "navigation" && payload && typeof payload.href === "string") urls.add(payload.href.slice(0, 2048));
        break;
      }
    }
  }
  if (!Number.isFinite(firstTs)) firstTs = lastTs = fallbackTs;
  return { firstTs, lastTs, hasFullSnapshot, urls: [...urls], errorCount, clickCount, traceIds: [...traceIds] };
}

export function objectKey(prefix: string, project: string, sessionId: string, seq: number): string {
  return `${prefix}${project}/${sessionId}/${String(seq).padStart(10, "0")}.json.gz`;
}

export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

export function isTraceId(v: string): boolean {
  return TRACE_ID_RE.test(v);
}

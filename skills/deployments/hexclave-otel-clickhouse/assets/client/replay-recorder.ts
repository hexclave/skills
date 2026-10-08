// Browser session-replay recorder for the hexclave replay-ingest service.
// npm i @rrweb/record@2.1.7 @rrweb/types@2.1.7
//
//   import { startReplay, getReplaySessionId } from "./replay-recorder";
//   startReplay({ endpoint: "https://<replay-ingest url>.deploy.built-with-hexclave.com", writeKey: "<public write key>", sampleRate: 0.2 });
//
// Privacy defaults: all inputs masked, text under [data-private] masked, [data-replay-block] not recorded.
// Write keys are public (they only allow appending replay chunks for one project). Rotate if abused.
import { record } from "@rrweb/record";
import type { eventWithTime } from "@rrweb/types";

export type ReplayOptions = {
  endpoint: string; // base URL of the replay-ingest service
  writeKey: string;
  sampleRate?: number; // 0..1, decided once per session (default 1)
  distinctId?: string; // your user id, if known
  flushIntervalMs?: number; // default 5000
  maxBatchEvents?: number; // default 500
  idleTimeoutMs?: number; // new session after this much inactivity (default 30 min)
};

type SessionState = { id: string; seq: number; lastActive: number; sampled: boolean };
type Batch = { session_id: string; seq: number; batch_id: string; distinct_id: string; sent_at_ms: number; trace_ids: string[]; events: eventWithTime[] };

const STORAGE_KEY = "hx_replay_session";
let opts: Required<Omit<ReplayOptions, "distinctId">> & { distinctId: string };
let session: SessionState | null = null;
let buffer: eventWithTime[] = [];
let traceIds = new Set<string>();
let retry: Batch[] = [];
let stopFn: (() => void) | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // randomUUID is missing on non-secure (plain http) origins.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function loadSession(): SessionState {
  const now = Date.now();
  try {
    const s = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null") as SessionState | null;
    if (s && now - s.lastActive < opts.idleTimeoutMs) return s;
  } catch {
    /* corrupted or blocked storage: start fresh */
  }
  return { id: uuid(), seq: 0, lastActive: now, sampled: Math.random() < opts.sampleRate };
}

function saveSession(): void {
  try {
    if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* storage may be unavailable (Safari private mode) */
  }
}

/** Current replay session id (UUID), or null when this session is not sampled. Put it on spans as session.id. */
export function getReplaySessionId(): string | null {
  return session?.sampled ? session.id : null;
}

async function gzip(text: string): Promise<Blob> {
  if (typeof CompressionStream === "undefined") return new Blob([text], { type: "text/plain" });
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  // text/plain keeps the request CORS-"simple" (no preflight). The server sniffs gzip magic bytes.
  return new Blob([await new Response(stream).arrayBuffer()], { type: "text/plain" });
}

function url(): string {
  return `${opts.endpoint.replace(/\/$/, "")}/v1/replay/batch?key=${encodeURIComponent(opts.writeKey)}`;
}

function takeBatch(): Batch | null {
  if (!session || buffer.length === 0) return null;
  const batch: Batch = {
    session_id: session.id,
    seq: session.seq++,
    batch_id: uuid(),
    distinct_id: opts.distinctId,
    sent_at_ms: Date.now(),
    trace_ids: [...traceIds],
    events: buffer,
  };
  buffer = [];
  traceIds = new Set();
  saveSession();
  return batch;
}

async function send(batch: Batch): Promise<boolean> {
  try {
    const res = await fetch(url(), { method: "POST", body: await gzip(JSON.stringify(batch)), credentials: "omit" });
    return res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429); // do not retry rejects
  } catch {
    return false;
  }
}

export async function flush(): Promise<void> {
  const batch = takeBatch();
  const pending = batch ? [...retry, batch] : retry;
  retry = [];
  for (const b of pending) {
    if (!(await send(b))) retry.push(b); // same seq + batch_id on retry, so the server write is idempotent
  }
  retry = retry.slice(-5); // cap memory if the endpoint is down
}

/** Page is going away: synchronous best effort. Beacon and keepalive bodies are capped at ~64 KB. */
function flushOnHide(): void {
  const batch = takeBatch();
  for (const b of batch ? [...retry, batch] : retry) {
    // Cannot await CompressionStream here; send plain JSON (the server accepts both).
    const body = new Blob([JSON.stringify(b)], { type: "text/plain" });
    if (!navigator.sendBeacon?.(url(), body)) {
      void fetch(url(), { method: "POST", body, keepalive: true, credentials: "omit" }).catch(() => {});
    }
  }
  retry = [];
}

function emit(event: eventWithTime): void {
  if (!session) return;
  const now = Date.now();
  if (now - session.lastActive > opts.idleTimeoutMs) {
    // Idle too long: close this session and start a new one with a fresh full snapshot.
    void flush();
    session = { id: uuid(), seq: 0, lastActive: now, sampled: Math.random() < opts.sampleRate };
    saveSession();
    if (!session.sampled) return stopReplay();
    record.takeFullSnapshot(true);
  }
  session.lastActive = now;
  buffer.push(event);
  if (buffer.length >= opts.maxBatchEvents) void flush();
}

/** Server-Timing: traceparent;desc="00-<trace>-<span>-01" on documents and API responses links replays to traces. */
function watchTraceparents(): void {
  if (typeof PerformanceObserver === "undefined") return;
  const seen = (entries: PerformanceEntryList) => {
    for (const e of entries as PerformanceResourceTiming[]) {
      for (const st of e.serverTiming ?? []) {
        if (st.name !== "traceparent") continue;
        const traceId = st.description.split("-")[1];
        if (traceId && /^[0-9a-f]{32}$/.test(traceId) && !/^0+$/.test(traceId)) {
          traceIds.add(traceId);
          record.addCustomEvent("trace", { traceId, url: e.name.slice(0, 512) });
        }
      }
    }
  };
  try {
    new PerformanceObserver((list) => seen(list.getEntries())).observe({ type: "resource", buffered: true });
    new PerformanceObserver((list) => seen(list.getEntries())).observe({ type: "navigation", buffered: true });
  } catch {
    /* older browsers */
  }
}

function watchErrors(): void {
  addEventListener("error", (e) =>
    record.addCustomEvent("error", { message: String(e.message).slice(0, 1000), source: e.filename, line: e.lineno, stack: String(e.error?.stack ?? "").slice(0, 4000) }),
  );
  addEventListener("unhandledrejection", (e) =>
    record.addCustomEvent("error", { message: String((e.reason as Error)?.message ?? e.reason).slice(0, 1000), stack: String((e.reason as Error)?.stack ?? "").slice(0, 4000) }),
  );
}

function watchNavigation(): void {
  const note = () => record.addCustomEvent("navigation", { href: location.href });
  for (const m of ["pushState", "replaceState"] as const) {
    const orig = history[m].bind(history);
    history[m] = (...args: Parameters<History["pushState"]>) => {
      orig(...args);
      note();
    };
  }
  addEventListener("popstate", note);
}

export function startReplay(options: ReplayOptions): void {
  if (stopFn || typeof window === "undefined") return;
  opts = { sampleRate: 1, flushIntervalMs: 5000, maxBatchEvents: 500, idleTimeoutMs: 30 * 60_000, distinctId: "", ...options };
  session = loadSession();
  saveSession();
  if (!session.sampled) return;

  stopFn = record({
    emit,
    maskAllInputs: true,
    maskTextSelector: "[data-private]",
    blockSelector: "[data-replay-block]",
    checkoutEveryNms: 5 * 60_000, // periodic full snapshot so playback can start mid-session
    sampling: { mousemove: 50, scroll: 150, input: "last", media: 800 },
    slimDOMOptions: "all",
    inlineStylesheet: true,
    recordCanvas: false,
    collectFonts: false,
  });
  watchTraceparents();
  watchErrors();
  watchNavigation();
  timer = setInterval(() => void flush(), opts.flushIntervalMs);
  addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushOnHide());
  addEventListener("pagehide", flushOnHide);
}

export function stopReplay(): void {
  stopFn?.();
  stopFn = undefined;
  if (timer) clearInterval(timer);
  void flush();
}

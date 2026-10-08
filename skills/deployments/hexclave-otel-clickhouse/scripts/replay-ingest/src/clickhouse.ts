// Minimal ClickHouse HTTP client (no dependencies). Uses server-side query parameters
// ({name:Type} placeholders + param_<name> URL params), so user input is never spliced into SQL.
import { config } from "./config";

function headers(reader = false): Record<string, string> {
  return {
    "X-ClickHouse-User": reader ? config.clickhouse.readerUser : config.clickhouse.user,
    "X-ClickHouse-Key": reader ? config.clickhouse.readerPassword ?? "" : config.clickhouse.password,
  };
}

export async function chInsertJSONEachRow(table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const url = new URL(config.clickhouse.url + "/");
  url.searchParams.set("query", `INSERT INTO ${table} FORMAT JSONEachRow`);
  // Async inserts batch many small writes server-side; wait=1 so a 200 means durable.
  url.searchParams.set("async_insert", "1");
  url.searchParams.set("wait_for_async_insert", "1");
  url.searchParams.set("date_time_input_format", "best_effort");
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/x-ndjson" },
    body: rows.map((r) => JSON.stringify(r)).join("\n"),
  });
  if (!res.ok) throw new Error(`ClickHouse insert into ${table} failed: ${res.status} ${await res.text()}`);
}

export async function chQuery<T>(sql: string, params: Record<string, string | number> = {}, opts: { reader?: boolean } = {}): Promise<T[]> {
  const url = new URL(config.clickhouse.url + "/");
  url.searchParams.set("default_format", "JSONEachRow");
  url.searchParams.set("output_format_json_quote_64bit_integers", "0");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(`param_${k}`, String(v));
  const res = await fetch(url, { method: "POST", headers: headers(opts.reader), body: sql });
  if (!res.ok) throw new Error(`ClickHouse query failed: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

export type BlobKey = { project: string; sessionId: string; seq: number };

/**
 * Stores one gzipped chunk in replay.chunk_blobs (used when no bucket is configured).
 * Binary goes through JSON as base64 and is decoded server-side by input(); a synchronous
 * INSERT ... SELECT, so a 200 means the blob is durable before the index row is written.
 */
export async function chPutBlob(key: BlobKey, firstTsIso: string, blob: Uint8Array): Promise<void> {
  const url = new URL(config.clickhouse.url + "/");
  url.searchParams.set("query",
    "INSERT INTO replay.chunk_blobs (project_id, session_id, seq, first_ts, blob) " +
    "SELECT project_id, session_id, seq, parseDateTime64BestEffort(first_ts, 3, 'UTC'), base64Decode(b64) " +
    "FROM input('project_id String, session_id UUID, seq UInt32, first_ts String, b64 String') FORMAT JSONEachRow");
  const row = { project_id: key.project, session_id: key.sessionId, seq: key.seq, first_ts: firstTsIso, b64: Buffer.from(blob).toString("base64") };
  const res = await fetch(url, { method: "POST", headers: { ...headers(), "Content-Type": "application/x-ndjson" }, body: JSON.stringify(row) });
  if (!res.ok) throw new Error(`ClickHouse blob insert failed: ${res.status} ${await res.text()}`);
}

/** Raw gzipped bytes of one chunk (FORMAT RawBLOB returns the String column verbatim). */
export async function chGetBlob(key: BlobKey): Promise<Uint8Array> {
  const url = new URL(config.clickhouse.url + "/");
  url.searchParams.set("param_project", key.project);
  url.searchParams.set("param_session", key.sessionId);
  url.searchParams.set("param_seq", String(key.seq));
  const sql = `SELECT blob FROM replay.chunk_blobs FINAL
    WHERE project_id = {project:String} AND session_id = {session:UUID} AND seq = {seq:UInt32}
    LIMIT 1 FORMAT RawBLOB`;
  const res = await fetch(url, { method: "POST", headers: headers(), body: sql });
  if (!res.ok) throw new Error(`ClickHouse blob read failed: ${res.status} ${await res.text()}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error(`chunk blob missing: ${key.project}/${key.sessionId}/${key.seq}`);
  return bytes;
}

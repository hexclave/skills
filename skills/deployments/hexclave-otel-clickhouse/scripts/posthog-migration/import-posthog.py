#!/usr/bin/env python3
"""Load events exported from PostHog Cloud (JSONL) into a ClickHouse table shaped like PostHog's events.

    CLICKHOUSE_URL=https://<proxy>/_ch/ CLICKHOUSE_USER=importer CLICKHOUSE_PASSWORD=... \\
      python3 import-posthog.py events.jsonl [delta-1.jsonl ...]

Input: one PostHog event per line: {"uuid", "event", "distinct_id", "timestamp", "properties",
["person_id"], ["elements_chain"]} (see references/posthog-migration.md for the export query).
Table: POSTHOG_TABLE (default telemetry.posthog_events), a ReplacingMergeTree keyed on
(event, toDate(timestamp), uuid), so re-running and overlapping exports are safe: duplicates
collapse on merge (count with FINAL or uniqExact(uuid)).
Property values become strings, the way the OTel collector stores attributes: strings as they
are, anything else as its JSON text (true, 12, ["a"]); nulls are dropped. Standard library only.
"""
import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BATCH = 5000
TABLE = os.environ.get("POSTHOG_TABLE", "telemetry.posthog_events")


def setting(name, default=None):
    value = os.environ.get(name, default)
    if value is None:
        raise SystemExit(f"{name} is not set\n\n{__doc__}")
    return value


def as_string(v):
    return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def row(e):
    ts = e["timestamp"].replace("T", " ").rstrip("Z")
    if "+" in ts[10:]:
        ts = ts[:10] + ts[10:].split("+")[0]
    return {
        "uuid": e["uuid"],
        "event": e["event"],
        "distinct_id": str(e["distinct_id"]),
        "timestamp": ts,
        "properties": {k: as_string(v) for k, v in (e.get("properties") or {}).items() if v is not None},
        "elements_chain": e.get("elements_chain") or "",
        "person_id": str(e.get("person_id") or ""),
    }


def post(rows):
    body = gzip.compress("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows).encode())
    query = (f"INSERT INTO {TABLE} (uuid, event, distinct_id, timestamp, properties, elements_chain, person_id) "
             "FORMAT JSONEachRow")
    url = setting("CLICKHOUSE_URL").rstrip("/") + "/?" + urllib.parse.urlencode(
        {"query": query, "date_time_input_format": "best_effort"})
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "X-ClickHouse-User": setting("CLICKHOUSE_USER", "importer"),
        "X-ClickHouse-Key": setting("CLICKHOUSE_PASSWORD"),
        "Content-Encoding": "gzip",
        "Content-Type": "application/octet-stream",
    })
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=300) as res:
                res.read()
                return
        except urllib.error.HTTPError as err:
            detail = err.read().decode(errors="replace")[:500]
            if err.code < 500 and err.code != 429:
                raise SystemExit(f"ClickHouse refused a batch ({err.code}): {detail}")
            print(f"  retry {attempt + 1}: {err.code} {detail[:120]}", file=sys.stderr)
        except urllib.error.URLError as err:
            print(f"  retry {attempt + 1}: {err}", file=sys.stderr)
        time.sleep(2 ** attempt)
    raise SystemExit("ClickHouse kept failing; re-run to continue (rows already sent are deduplicated)")


def main(paths):
    if not paths:
        raise SystemExit(__doc__)
    total = 0
    for path in paths:
        batch = []
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    batch.append(row(json.loads(line)))
                if len(batch) >= BATCH:
                    post(batch)
                    total += len(batch)
                    print(f"{path}: {total} rows", file=sys.stderr)
                    batch = []
        if batch:
            post(batch)
            total += len(batch)
        print(f"{path}: done, {total} rows so far", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])

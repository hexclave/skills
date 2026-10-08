#!/usr/bin/env bash
# Deploy the observability stack (clickhouse, otel-gateway, replay-ingest) with Hexclave
# Deployments on its default runtime. Dry run by default: assembles the deploy directory.
#
#   scripts/hexclave-deploy.sh                 # dry run (no network calls)
#   scripts/hexclave-deploy.sh --check         # + read-only GETs: existing services/deployments
#   scripts/hexclave-deploy.sh --apply         # hexclave deploy (billable: 8GB server + 500GB volume + 3 machines)
#   scripts/hexclave-deploy.sh --verify        # smoke-test the public URLs (GATEWAY_URL, REPLAY_URL); exit 1 on failure
#   scripts/hexclave-deploy.sh --pause         # redeploy with every minInstances = 0 (idle machines stop; volume kept;
#                                              #   a request still autostarts them). There is no tenant stop/park API.
#   scripts/hexclave-deploy.sh --resume        # redeploy with the normal floors (ClickHouse always on, 2 gateways, 1 replay)
#   scripts/hexclave-deploy.sh --logs <svc> [since_millis]   # runtime logs of one service, secrets masked
#   scripts/hexclave-deploy.sh --build-logs <deploymentId>   # build logs of one deployment
#
# Inputs (env or ./hexclave-obs.env; generated values go to ./secrets.env, chmod 600):
#   HEXCLAVE_PROJECT_ID, HEXCLAVE_SECRET_SERVER_KEY   project id + secret server key (or `hexclave login`)
#   No bucket needed. Optional object storage:
#     CH_S3_ENDPOINT + CH_S3_ACCESS_KEY_ID + CH_S3_SECRET_ACCESS_KEY [+ CH_S3_REGION, CH_S3_BATCH_DELETE=false for GCS]
#         -> ClickHouse tiers parts older than OTEL_HOT_DAYS to the bucket (else: volume only, TTL delete)
#     REPLAY_BUCKET + REPLAY_S3_ENDPOINT + REPLAY_S3_ACCESS_KEY_ID + REPLAY_S3_SECRET_ACCESS_KEY
#         -> replay chunk blobs in the bucket (else: in ClickHouse, replay.chunk_blobs)
#   optional: CH_VOLUME_GB (500), CH_S3_CACHE_SIZE (200Gi), OTEL_HOT_DAYS (1), OTEL_TTL_DAYS (30),
#             REPLAY_TTL_DAYS, OTEL_GATEWAY_INSTANCES (2), REPLAY_ALLOWED_ORIGINS, REPLAY_PROJECT (hexclave),
#             HEXCLAVE_CLI (command to run the CLI; default: npx -y @hexclave/cli@<pinned>)
set -euo pipefail
HEXCLAVE_CLI_VERSION="1.0.125"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK_DIR="${WORK_DIR:-$PWD/.hexclave-obs-deploy}"
MODE=dry
case "${1:-}" in
  --apply) MODE=apply ;;
  --pause) MODE=apply; export OBS_SCALE_TO_ZERO=1 ;; --resume) MODE=apply; unset OBS_SCALE_TO_ZERO ;; --verify) MODE=verify ;; --check) MODE=check ;; ""|--dry-run) ;;
  --logs|--build-logs) MODE="${1#--}"; TARGET="${2:?$1 needs a service id / deployment id}"; SINCE="${3:-}" ;;
  -h|--help) sed -n '2,26p' "$0"; exit 0 ;; *) echo "unknown arg $1" >&2; exit 2 ;;
esac

[[ -f ./hexclave-obs.env ]] && { set -a; . ./hexclave-obs.env; set +a; }
SECRETS_FILE="${SECRETS_FILE:-$PWD/secrets.env}"
rand() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

if [[ "$MODE" == logs || "$MODE" == build-logs ]]; then
  # Runtime logs are NOT redacted by the platform: mask every value from secrets.env before printing.
  : "${HEXCLAVE_PROJECT_ID:?}" "${HEXCLAVE_SECRET_SERVER_KEY:?}"
  api="${HEXCLAVE_API_URL:-https://api.hexclave.com}/api/latest"
  if [[ "$MODE" == logs ]]; then path="/deployments/services/$TARGET/logs?follow=false${SINCE:+&since_millis=$SINCE}"
  else path="/deployments/deployments/$TARGET/logs"; fi
  curl -sS "$api$path" -H "x-stack-access-type: server" -H "x-stack-project-id: $HEXCLAVE_PROJECT_ID" \
    -H "x-stack-secret-server-key: $HEXCLAVE_SECRET_SERVER_KEY" | SECRETS_FILE="$SECRETS_FILE" python3 -c '
import json, os, sys
vals = [os.environ["HEXCLAVE_SECRET_SERVER_KEY"]]
if os.path.exists(os.environ["SECRETS_FILE"]):
    for line in open(os.environ["SECRETS_FILE"]):
        if "=" in line:
            for v in line.strip().split("=", 1)[1].split(","):
                vals += [v, v.split(":", 1)[-1]]
vals = sorted({v for v in vals if len(v) >= 8}, key=len, reverse=True)
for raw in sys.stdin:
    try:
        j = json.loads(raw)
        text = "%s %s %s" % (j.get("at_millis"), (j.get("instance") or j.get("stream") or "")[:8], j.get("text", ""))
    except Exception:
        text = raw.rstrip()
    for v in vals: text = text.replace(v, "***")
    print(text.rstrip())'
  exit 0
fi

if [[ "$MODE" == verify ]]; then
  : "${GATEWAY_URL:?GATEWAY_URL=https://... (printed by deploy)}" "${REPLAY_URL:?REPLAY_URL=https://...}"
  [[ -f "$SECRETS_FILE" ]] && { set -a; . "$SECRETS_FILE"; set +a; }
  tok="${OTEL_INGEST_TOKENS%%,*}" fails=0
  check() { if [[ "$3" == $2 ]]; then echo "ok   $1: $3"; else echo "FAIL $1: got $3, want $2"; fails=$((fails + 1)); fi; }
  now=$(($(date +%s) * 1000000000))
  check "unauthenticated OTLP" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GATEWAY_URL/v1/logs" -H 'content-type: application/json' -d '{}')"
  check "OTLP/HTTP log with token" 200 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GATEWAY_URL/v1/logs" \
    -H "authorization: Bearer $tok" -H 'content-type: application/json' \
    -d "{\"resourceLogs\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"hexclave-obs-verify\"}}]},\"scopeLogs\":[{\"logRecords\":[{\"timeUnixNano\":\"$now\",\"severityText\":\"INFO\",\"body\":{\"stringValue\":\"verify\"}}]}]}]}")"
  check "replay healthz" ok "$(curl -s "$REPLAY_URL/healthz")"
  check "replay sessions without token" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$REPLAY_URL/v1/replay/sessions?project=${REPLAY_PROJECT:-hexclave}")"
  check "replay sessions with read token" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$REPLAY_URL/v1/replay/sessions?project=${REPLAY_PROJECT:-hexclave}" -H "authorization: Bearer $REPLAY_READ_TOKEN")"
  sleep 8 # gateway batches flush every 5s
  summary=$(curl -s "$REPLAY_URL/v1/otel/summary?minutes=15&service=hexclave-obs-verify" -H "authorization: Bearer $REPLAY_READ_TOKEN")
  echo "     ClickHouse summary for hexclave-obs-verify: $summary"
  check "otel_logs row landed in ClickHouse" yes "$(printf '%s' "$summary" | python3 -c 'import json,sys
try: d = json.load(sys.stdin)
except Exception: print("no"); raise SystemExit
rows = [r for r in d.get("rows", []) if r.get("table") == "otel_logs" and int(r.get("rows", 0)) > 0]
print("yes" if rows else "no")')"
  [[ $fails -eq 0 ]] && echo "verify: all checks passed" || { echo "verify: $fails check(s) failed"; exit 1; }
  exit 0
fi

# 1. Generated secrets: created once, never overwritten.
touch "$SECRETS_FILE"; chmod 600 "$SECRETS_FILE"
set -a; . "$SECRETS_FILE"; set +a
gen() { local k="$1" v="$2"; if [[ -z "${!k:-}" ]]; then printf '%s=%s\n' "$k" "$v" >> "$SECRETS_FILE"; export "$k=$v"; echo "generated $k -> $SECRETS_FILE"; fi; }
for k in CLICKHOUSE_ADMIN_PASSWORD CLICKHOUSE_OTEL_PASSWORD CLICKHOUSE_REPLAY_PASSWORD CLICKHOUSE_READER_PASSWORD REPLAY_READ_TOKEN; do gen "$k" "$(rand)"; done
gen OTEL_INGEST_TOKENS "otlp_$(rand)"
gen REPLAY_WRITE_KEYS "${REPLAY_PROJECT:-hexclave}:pk_$(rand | cut -c1-32)"

# 2. Inputs. Buckets are optional, but each one is all-or-nothing.
missing=()
if [[ -n "${CH_S3_ENDPOINT:-}" ]]; then
  for k in CH_S3_ACCESS_KEY_ID CH_S3_SECRET_ACCESS_KEY; do [[ -n "${!k:-}" ]] || missing+=("$k"); done
  [[ "$CH_S3_ENDPOINT" == */ ]] || { echo "CH_S3_ENDPOINT must end with '/'" >&2; exit 1; }
  echo "clickhouse storage: tiered (volume + ${CH_S3_ENDPOINT%%/*}//...)"
else
  echo "clickhouse storage: volume only (${CH_VOLUME_GB:-500}GB), TTL delete after ${OTEL_TTL_DAYS:-30} days"
fi
if [[ -n "${REPLAY_BUCKET:-}" ]]; then
  for k in REPLAY_S3_ENDPOINT REPLAY_S3_ACCESS_KEY_ID REPLAY_S3_SECRET_ACCESS_KEY; do [[ -n "${!k:-}" ]] || missing+=("$k"); done
  echo "replay blobs: bucket $REPLAY_BUCKET"
else
  echo "replay blobs: ClickHouse (replay.chunk_blobs)"
fi
if [[ "$MODE" == apply || "$MODE" == check ]]; then
  [[ -n "${HEXCLAVE_PROJECT_ID:-}" ]] || missing+=(HEXCLAVE_PROJECT_ID)
  [[ -n "${HEXCLAVE_SECRET_SERVER_KEY:-}" ]] || echo "note: HEXCLAVE_SECRET_SERVER_KEY unset, the CLI will use your 'hexclave login' session"
fi

# 3. Assemble the upload root (the CLI uploads the deploy file's directory once).
rm -rf "$WORK_DIR"; mkdir -p "$WORK_DIR/scripts"
cp -R "$SKILL_DIR/assets/clickhouse" "$SKILL_DIR/assets/gateway" "$SKILL_DIR/assets/sql" "$SKILL_DIR/assets/hexclave" "$WORK_DIR/"
cp "$SKILL_DIR/scripts/set-retention.sh" "$WORK_DIR/scripts/"
mkdir -p "$WORK_DIR/replay-ingest"
cp -R "$SKILL_DIR/scripts/replay-ingest/src" "$SKILL_DIR/scripts/replay-ingest/package.json" \
      "$SKILL_DIR/scripts/replay-ingest/tsconfig.json" "$SKILL_DIR/scripts/replay-ingest/Dockerfile" "$WORK_DIR/replay-ingest/"
mv "$WORK_DIR/hexclave/hexclave.deploy.ts" "$WORK_DIR/hexclave.deploy.ts"
printf 'node_modules\n.git\nsecrets.env\n*.env\n' > "$WORK_DIR/.gitignore"
echo "assembled $WORK_DIR:"; (cd "$WORK_DIR" && find . -type f | sort | sed 's/^/  /')

if ((${#missing[@]})); then
  echo "missing inputs: ${missing[*]}" >&2
  [[ "$MODE" == apply ]] && exit 1
fi
if [[ "$MODE" == check ]]; then
  # Read-only: what the project already has. A project with deployment history on another
  # runtime cannot switch (backend: "Create a new project to test another runtime").
  : "${HEXCLAVE_SECRET_SERVER_KEY:?--check needs HEXCLAVE_SECRET_SERVER_KEY}"
  api="${HEXCLAVE_API_URL:-https://api.hexclave.com}/api/latest"
  get() { curl -sS -X GET "$api$1" -H "x-stack-access-type: server" -H "x-stack-project-id: $HEXCLAVE_PROJECT_ID" \
            -H "x-stack-secret-server-key: $HEXCLAVE_SECRET_SERVER_KEY" -w ' (HTTP %{http_code})'; echo; }
  echo "services:    $(get /deployments/services)"
  echo "deployments: $(get /deployments/deployments)"
  echo "note: the plan is not readable with a server key; --apply fails at the definitions sync"
  echo "      (before any upload) if the plan does not allow an always-on 8GB server or a 500GB volume."
  exit 0
fi
if [[ "$MODE" == dry ]]; then
  echo "dry run done. Next: scripts/hexclave-deploy.sh --apply   (paid plan: always-on 8GB server, 500GB volume)"
  exit 0
fi

# 4. Deploy with a CLEAN env: the deploy file reads process.env for secret fallbacks and sizing,
#    so stray variables from this shell must not leak into it.
pass=(PATH HOME HEXCLAVE_PROJECT_ID HEXCLAVE_SECRET_SERVER_KEY HEXCLAVE_API_URL
  CH_S3_ENDPOINT CH_S3_REGION CH_S3_BATCH_DELETE CH_S3_ACCESS_KEY_ID CH_S3_SECRET_ACCESS_KEY CH_VOLUME_GB CH_S3_CACHE_SIZE
  CLICKHOUSE_ADMIN_PASSWORD CLICKHOUSE_OTEL_PASSWORD CLICKHOUSE_REPLAY_PASSWORD CLICKHOUSE_READER_PASSWORD
  OTEL_HOT_DAYS OTEL_TTL_DAYS REPLAY_TTL_DAYS OTEL_GATEWAY_INSTANCES OTEL_QUEUE_STORAGE OTEL_INGEST_TOKENS
  REPLAY_BUCKET REPLAY_S3_ENDPOINT REPLAY_S3_REGION REPLAY_S3_ACCESS_KEY_ID REPLAY_S3_SECRET_ACCESS_KEY
  REPLAY_WRITE_KEYS REPLAY_READ_TOKEN REPLAY_ALLOWED_ORIGINS REPLAY_MIN_INSTANCES REPLAY_MAX_INSTANCES OBS_SCALE_TO_ZERO)
envargs=(); for k in "${pass[@]}"; do [[ -n "${!k:-}" ]] && envargs+=("$k=${!k}"); done
cd "$WORK_DIR"
read -r -a cli <<< "${HEXCLAVE_CLI:-npx -y @hexclave/cli@${HEXCLAVE_CLI_VERSION}}"
env -i "${envargs[@]}" "${cli[@]}" deploy 2>&1 | tee "$WORK_DIR/deploy.log"
rc="${PIPESTATUS[0]}"
((rc == 0)) && echo "Then: GATEWAY_URL=<otel-gateway url> REPLAY_URL=<replay-ingest url> scripts/hexclave-deploy.sh --verify"
exit "$rc"

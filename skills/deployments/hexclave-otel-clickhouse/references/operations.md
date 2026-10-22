# Operating the stack with the Hexclave CLI

Everything here was learned running a production telemetry stack (OTel collector, ClickHouse, an
object store and a static site, all on Hexclave Deployments) for about three weeks.

## Admin through `hexclave exec`, not the browser

`hexclave exec` runs JavaScript with a server app that has full admin access to the project.
Use it for domains, secrets, service state and logs. Don't drive the dashboard in a browser:
the browser may be signed into a different Hexclave account than the CLI, and Hexclave's own
docs tell agents not to add domains through the UI.

```bash
npx -y @hexclave/cli@<pinned> exec --cloud-project-id "$HEXCLAVE_PROJECT_ID" '
  const p = await hexclaveServerApp.getProject();
  return await p.listDeploymentServices();
'
```

Methods used in practice (read `@hexclave/{js,shared,cli}/src` in the npx cache for the exact
signatures when the docs are silent; that source answered questions the docs assistant couldn't):

| Call | Returns / does |
|---|---|
| `p.listDeploymentServices()` | id, type, min/max instances, memory, cpu, persistent volumes, `parked_at`, domains, latest deployment id |
| `p.listDeployments({ limit })` | recent deployments and their per-service status |
| `p.addDeploymentServiceDomain(serviceId, host)` | attaches a custom domain; returns `status: "awaiting_dns"` and the `dns_records` to create (plus a `bind_zone_file`) |
| `p.getDeploymentServiceDomain(serviceId, host)` | poll it: `awaiting_dns` → `issuing` → `verified` (about 40 s after the records resolve) |
| `p.getDeploymentServiceLogs(serviceId, { sinceMillis, follow: false, onLine })` | runtime logs, at most 100 lines per call starting at `sinceMillis`; page by moving `sinceMillis` past the last `at_millis`. Both `sinceMillis` and an `onLine` function are required (`Cannot read properties of undefined (reading 'sinceMillis')` / `options.onLine is not a function` otherwise) |
| `p.getDeploymentBuildLogs(deploymentId)` | build output (`MARSHAL_TARGET_START/DONE`, `MARSHAL_BUILD_FAILED`) |
| `p.setProjectSecret(key, value)`, `p.listProjectSecrets()`, `p.deleteProjectSecret(key)` | project secrets read by `secret(KEY)` in the deploy file |
| `hexclaveServerApp.getPlanUsage()` | plan id and limits |

Rules that kept this safe:
- Pass secret values through stdin or an env var into the script. Never put them in the command
  line or print them. Runtime logs are not redacted, so mask before quoting.
- `exec` output starts with `npm warn` lines; strip them before parsing JSON.
- There is no shell or exec into a running container. Everything you need from inside a container
  has to come out through its logs or a port.

## Custom domains

1. `addDeploymentServiceDomain(service, host)`. DNS records alone don't issue a certificate: a host
   pointed at the service without being attached fails TLS (`SSL_ERROR_SYSCALL`).
2. Create the returned records at the registrar: a CNAME (or A/AAAA for an apex) to the service's
   `*.fly.dev` name, a `_fly-ownership` TXT and an `_acme-challenge` CNAME to `*.flydns.net`. If the
   zone is on Cloudflare, keep these DNS-only (the zone file marks them `cf-proxied:false`).
3. Poll `getDeploymentServiceDomain` until `verified`.

Keep every hostname that shipped clients still call attached for good. Old app builds keep
calling the old domain for their telemetry and update feeds.

## Deploying one service

`hexclave deploy --service-id <id>` builds and rolls out only that service. Its references to
other services resolve against what's already deployed. Use it when only ClickHouse changed, so
the collector isn't restarted and doesn't drop what's in its in-memory queue. The CLI still prints
"Syncing N service definitions", but only the named service rolls out. `--no-build-logs` skips
streaming the build.

## Always on, and scale to zero

- `serverless` defaults to `minInstances: 0`. It **stops** on scale-down, so each start is a cold
  start from a clean root filesystem (a file-backed collector queue on it doesn't survive). A public
  site at min 0 cold-starts on the next visit; set `minInstances: 1` to keep one up.
- `server` defaults to `minInstances: 1`. 0 suspends it when idle; it must be 0 or 1. Write the 1
  out explicitly so nobody flips it.
- Always-on services count against a 32GB per-project memory cap (`MAX_PROJECT_ALWAYS_ON_MEMORY_MB`).
- Free plan: `minInstances` must be 0, more than 512MB needs a paid plan, one volume of at most
  10GB, and deployments are parked after 24h.
- A service with **no ports** (a worker) can't be woken by traffic: at min 0 it stays stopped. A
  private service with ports (ClickHouse) is woken by the Fly proxy when a peer connects.

## Volumes are tied to the group and service id

- A volume belongs to `(deploymentGroupId, serviceId, volumeId)`. Renaming any of them gives the
  service a **new, empty** disk. To keep the data, keep the old names, even when they no longer fit.
- Removing a service or renaming it **detaches** its disk. The detached disk keeps billing, and there's
  no tenant API to delete it (ask Hexclave support).
- A reused disk may hold another program's files. Point the new data dir at a fresh path (for
  example `/data/ch/`) instead of trusting what's at `/data/clickhouse`.

## Health after a deploy

`deployed` means the rollout finished, not that the container is healthy. A service can report
`deployed` while it crash-loops. Read its runtime logs after every deploy. `startCommand` is one
line run through `/bin/sh -c`, so join steps with `&&` or `;`, never with a space.

## Reaching the private ClickHouse from a laptop

ClickHouse stays private. To query it from outside the project (scripts, a stats CLI, an agent),
put a narrow reverse proxy in front of its HTTP port on a public service you already run (see
[variants.md](variants.md)):
- accept only the read-only user (`X-ClickHouse-User: reader`, or Basic auth for `reader` only),
  and refuse `?user=` and `?password=` query parameters;
- rate-limit with `nodelay` (`limit_req zone=reader burst=20 nodelay`). Without `nodelay`, nginx
  spaced queued requests 200 ms apart, and 4 parallel queries took 1.75 s instead of 0.6 s;
- map both `/_ch` and `/_ch/`. A 301 from `/_ch` to `/_ch/` made clients retry the POST as a
  bodyless GET.

Every request pays the trip to the nearest Fly edge (about 0.35 s from India to Singapore) on top
of server time, so batch several statements and run about 4 in parallel instead of one by one.

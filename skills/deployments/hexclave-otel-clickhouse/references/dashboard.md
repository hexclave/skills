# A private dashboard on Hexclave

Grafana or HyperDX work (see SKILL.md). This page is the other route, a custom dashboard
deployed in the same project. It was built and run in production against a telemetry ClickHouse
that also ingests live data. Files: `assets/dashboard/`.

## Shape

- **App:** TanStack Start in SPA mode (`tanstackStart({ spa: { enabled: true } })`). The browser
  gets a static shell. The only server surface is `createServerFn`, served by `server.mjs` (srvx).
- **Auth:** Hexclave Auth in the same project. Use your own email + password form that calls
  `hexclaveClientApp.signInWithCredential({ email, password, noRedirect: true })` with
  `tokenStore: "cookie"`, so there's no hosted redirect or `/handler` route. Every data function
  runs `requireAllowed` (`assets/dashboard/auth.ts`). It reads the session cookie on the server
  (`getUser({ tokenStore: request })`), requires a verified primary email on
  `DASHBOARD_ALLOWED_EMAILS` (trimmed, lowercased) and answers `Cache-Control: private, no-store`.
- **Lock the auth project down** with `hexclave exec`: `updateConfig({ "auth.allowSignUp": false,
  "domains.trustedDomains.<id>": { baseUrl: "https://dash.example.com", handlerPath: "/handler" } })`,
  then create the allowed users with `createUser({ primaryEmail, primaryEmailVerified: true, password })`.
- **Data:** POST to `http://<CLICKHOUSE_HOST>:8123/` with `X-ClickHouse-User` / `X-ClickHouse-Key`
  headers and `FORMAT JSONCompact`, as `reader` (`readonly=2`, so per-query settings are allowed).
- **Deploy:** its own group (`assets/dashboard/hexclave.deploy.ts`), `serverless`, public, min = max
  = 1, since the cache and gate live in one process. Env comes from references: `hexclave.projectId`,
  `hexclave.secretServerKey`, `service("clickhouse").hostname()`, `secret(...)`.
- **Domain:** `addDeploymentServiceDomain("dashboard", "dash.example.com")`, see
  [operations.md](operations.md).

## Protect ClickHouse from the dashboard

The first version sent about 20 queries per page load. On a 4GB ClickHouse (Fly shared-cpu-2x,
86% CPU steal once its burst credit was spent) that piled up to 29 concurrent reader queries
running 30–74 s and holding 1.35 GB. A trivial count took 7 s, queries kept running after the
browser gave up, and the dashboard showed nothing. `assets/dashboard/clickhouse.ts` is the fix:

| Measure | Setting |
|---|---|
| One server-wide gate | at most 2 queries in flight; identical SQL joins the running query |
| Cache | 5 min fresh, then stale-while-revalidate; kept 6 h; LRU capped at 300 entries / 64 MB |
| Stable cache keys | quantize time windows to 5 minutes, so a reload hits the cache |
| Per-query limits | `max_execution_time=15`, `max_memory_usage=500000000`, client timeout 20 s; show error 159 as a timeout |
| Cancellation | the request's `AbortSignal` aborts the fetch once the last waiter leaves; `cancel_http_readonly_queries_on_client_close=1` stops the server side |
| Query shape | every query filters on the event and the timestamp; the previous period rides in the same scan (`-If` combinators, `GROUPING SETS`); breakdowns fold into one `arrayJoin` query; `uniq` over `uniqExact` |
| UI | each section loads on its own with a skeleton, and a failed one shows its error inline with a retry |

After the fix a cold page made at most 2 reader queries at a time (longest 14.7 s), and a warm
page sent none.

The bigger win was in the schema. Decoding a `Map` attribute column row by row was most of every
query's cost. Typed `MATERIALIZED` columns for the keys every query filters on cut a 90-day
visitor count from 63.5 MB read in 148 ms to 3.0 MB in 24 ms, with the same result. See
[schema.md](schema.md#typed-columns-for-hot-attributes). If the dashboard matters, give ClickHouse
8GB (dedicated cores) instead of 4GB.

## Hardening found in review

- Run independent halves of a request under `Promise.all` with one shared abort signal. A promise
  that rejects before anything awaits it kills Node with an unhandled rejection; log those in
  `server.mjs` instead of exiting.
- Bound everything you load from object storage: per-fetch timeouts, a compressed-size cap
  (check both `Content-Length` and the bytes actually read), streamed gunzip with an output cap,
  and a per-request budget. One unbounded replay chunk grew RSS by 1.2 GB.
- When an aborted request cleans up its in-flight cache entry, check it still owns the entry
  before deleting it. Otherwise a third identical call starts a duplicate query.
- Decode the path before routing, refuse the shell file under any encoding, and put the security
  headers on every response, static files included.
- A sign-in `next` parameter must resolve to the same origin (`/\evil.example` doesn't).

## Local development

- `optimizeDeps: { include: ["@hexclave/tanstack-start"] }` in `vite.config.ts`. Without it, the
  SDK's CommonJS dependencies are served unbundled and lazy routes fail with "Failed to fetch
  dynamically imported module".
- In a pnpm monorepo, keep the dashboard out of the workspace (`!apps/dashboard`) with its own
  lockfile and `--ignore-workspace`. Inside the workspace it hoisted a second React into the
  root lockfile and broke another app's build.
- An empty `.hexclave-config-error-overlay` element mounts on localhost pages. It stays empty
  unless the project config has errors.

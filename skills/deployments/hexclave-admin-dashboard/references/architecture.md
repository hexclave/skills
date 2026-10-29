# How the admin dashboard fits together

```
browser ──HTTPS──▶ dashboard (public serverless, Bun)
   │                 │  1. getUser({ tokenStore: request })   ──▶ Hexclave API
   │                 │  2. verified email + hasPermission(p)
   │                 │  3. forward /api/x → /internal/dashboard/x
   │                 ▼     Authorization: Bearer <dashboard token>, x-dashboard-admin: <email>
   │              backend (private server) ──▶ database, queues, agents…
   │
   └──hosted sign-in──▶ Hexclave hosted pages ──back to a trusted domain──▶ dashboard
```

## Why this shape

- **The backend stays the only thing that touches data.** The dashboard has no database URL,
  no storage keys and no backend secrets beyond one bearer token. Whatever the backend enforces
  (tenancy, audit, validation, idempotency) applies to admin actions too, and there's one code
  path for each operation.
- **Hexclave decides who is an admin.** A `project`-scoped permission is granted per account in
  the Hexclave dashboard or by the admin SDK. There's no email list in code or env to keep in
  step, and revoking takes effect on the next request.
- **The check happens on the dashboard's server, every request.** The page also asks `/api/me`
  to choose what to show, but that's only for the UI. The server re-checks the session and the
  permission before forwarding anything.
- **A path allowlist on the proxy.** The dashboard forwards only the paths it knows, so the
  bearer token can't be used through it to reach other internal routes.
- **Public serverless, scaled to zero.** The GCP runtime can't connect one service to a private
  `serverless` one, but a public `serverless` service can call a private `server`. An admin tool
  needs one instance and can sleep.
- **Same deployment group as the backend.** `service("backend").url(port)` resolves when the
  referring service deploys; a GCP `server` gets a new private IP on each redeploy, so the
  dashboard has to redeploy with it.

## Sign-in flow (hosted pages)

1. Page loads, constructs `HexclaveClientApp` (cookie token store, hosted URLs), calls `/api/me`.
2. `signed-out` → `redirectToSignIn()` → Hexclave's hosted page (email code).
3. The hosted pages live on `<projectId>.built-with-hexclave.com`, so sign-in is a cross-domain
   handoff: the dashboard's URL goes out in `after_auth_return_to` with `hexclave_cross_domain_*`
   parameters (state, PKCE challenge, where to land), and the browser comes back with
   `?code=…&state=…`. Only a trusted domain is allowed as the return address.
4. The client's constructor sees the callback, exchanges the code and stores the refresh token in
   the `hexclave-refresh-<projectId>--default` cookie (`__Host-` prefixed on HTTPS) and the access
   token in `hexclave-access`.
5. Every API call sends `Authorization` from `getAuthorizationHeader()`; the server reads it with
   `getUser({ tokenStore: request })`.

## What to show

Pages that worked for a multi-tenant app:

- **Search** across tenants by name, a member's name, phone or email digits, or any id (an exact
  UUID match on tenant and member ids). Escape `%` and `_` before `ILIKE`. With an empty query,
  list the recently active ones.
- **Tenant page**: details, members with flags (owner, left, never set up), recent problem reports.
- **Member page**: their recent activity (newest 200), their settings, and the actions.
- Poll every few seconds while a page is open instead of building a push channel; an admin tool
  has a handful of users.

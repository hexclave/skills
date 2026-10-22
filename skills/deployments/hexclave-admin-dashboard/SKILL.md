---
name: hexclave-admin-dashboard
description: Build and deploy a private admin dashboard (an internal tool for your own team) on Hexclave Deployments, signed in with Hexclave Auth and limited to people holding a project permission, next to an existing app whose backend stays private. Use when the user wants an admin panel, back office, support console or ops dashboard on Hexclave; wants to search customers, teams or orgs and act on them; wants to watch or steer an AI agent's conversations; or asks how to put a web UI behind Hexclave sign-in on Hexclave Deployments.
license: MIT
compatibility: Needs a Hexclave project with the Authentication, RBAC and Deploy apps, its HEXCLAVE_PROJECT_ID and HEXCLAVE_SECRET_SERVER_KEY, `hexclave login` on the machine that does the one-time setup, and Bun 1.3+. Docker is only needed to test the image locally.
metadata:
  author: hexclave
  version: "1.0.0"
  verified-on: "Hexclave Deployments GCP runtime (gcp-beta-1, us-central1), @hexclave/js and @hexclave/cli 1.0.125, Bun 1.3.14, React 19, Tailwind 4 (2026-10-22)"
---

# Admin dashboard on Hexclave Deployments

One extra service in the app's existing deployment group:

| Piece | What | Exposure |
|---|---|---|
| `dashboard` service | Bun server: Hexclave sign-in check, permission check, proxy to the backend; serves a React page | public HTTPS, `serverless`, 0–1 instances |
| Backend's dashboard routes | `/internal/dashboard/*` on the existing private backend, bearer token | private only |
| `hexclave.config.ts` | a `project`-scoped permission and a sign-in method | pushed to the project |
| Trusted domain, admin accounts | set once with [scripts/admin-setup.ts](scripts/admin-setup.ts) | project settings |

The dashboard holds no database credentials. It checks who is signed in and forwards allowed
requests to routes the backend already serves privately, so the backend stays the only thing that
touches data, and the rules it enforces apply to the dashboard too.

Read [references/architecture.md](references/architecture.md) for the request flow and why each
piece is where it is, and [references/agent-steering.md](references/agent-steering.md) if the app
is an AI agent and the dashboard should read and steer its conversations.

## Prerequisites

- The project already deploys a backend with `hexclave deploy`, and it has a private service the
  dashboard can call (`public: false`). On the GCP runtime that service must be a `server`: a
  private `serverless` service can't be reached from another service.
- Deploying changes a live project. Get the user's go-ahead for the specific project. Never print
  `HEXCLAVE_SECRET_SERVER_KEY` or the backend token.
- Decide the permission id (for example `admin_dashboard`) and the admins' emails with the user.

## Workflow

### 1. Project config: a permission and a way to sign in

Add to `hexclave.config.ts` (see [assets/hexclave.config.ts](assets/hexclave.config.ts)):

```ts
auth: { allowSignUp: false, otp: { allowSignIn: true } },
rbac: { permissions: { admin_dashboard: { description: "Use the admin dashboard", scope: "project" } } },
```

- **Every sign-in method is off by default** (password, OTP, passkey, OAuth). If the project
  never needed people to sign in, enable one, or the hosted sign-in page has nothing to offer.
  Email codes (`otp`) need no secrets.
- `allowSignUp: false` keeps strangers out; admins get accounts in step 5.
- Use the nested form. `defineHexclaveConfig` in 1.0.125 rejects the flat `"auth.otp"` key that
  the docs' style guide prefers.
- Push it: `hexclave config push --config-file hexclave.config.ts`. It works with
  `HEXCLAVE_SECRET_SERVER_KEY`, so CI can run it before every deploy, which keeps the project in
  step with the file. Pull first (`hexclave config pull --config-file /tmp/current.config.ts`,
  needs `hexclave login`) and diff, so the push doesn't drop settings someone made by hand. A
  push replaces the previously pushed config.

### 2. Backend routes

Add read and action routes under `/internal/dashboard/` on the private backend. Each one:

- checks `Authorization: Bearer <token>` in constant time; reuse an internal token the backend
  already has, or add one;
- validates path params and bodies (ids as UUIDs, text length);
- returns `cache-control: no-store`;
- logs actions with the admin's email from the `x-dashboard-admin` header. The header is only for
  the log: the dashboard sets it after checking the user, and the backend trusts nothing else in it.

Write actions as the app's own operations (start a job, cancel, reset), not as raw table
writes, so the backend's own checks and audit trail still apply. [assets/backend-routes.ts](assets/backend-routes.ts)
shows the shape.

### 3. The dashboard app

Start from [assets/app/](assets/app/) (Bun + React + Tailwind, typechecked):

- `src/server.ts`: `Bun.serve` with an HTML import. `/api/project` hands the page the project id
  and API URL; `/api/me` says `signed-out`, `denied` or `allowed`; every other `/api/*` requires a
  verified primary email and `user.hasPermission(<permission>)` (project scope, no team argument),
  then forwards to `DASHBOARD_BACKEND_URL` with the bearer token. Add an allowlist regex of
  backend paths, so the proxy can't reach other internal routes.
- `src/hexclave.ts`: `HexclaveClientApp` with `tokenStore: "cookie"`, `urls: { default: { type:
  "hosted" } }`, analytics and replays off, `devTool: false`. `call()` sends
  `getAuthorizationHeader()`; a 401 sends the person to sign in again.
- **Construct the client on page load, before anything rewrites the URL.** With hosted URLs the
  SDK finishes the sign-in callback (`?code=…&state=…`) inside the constructor, and `getUser()`
  waits for it.
- **Turn analytics and replays off** when the dashboard shows customer data: with the project's
  Analytics app on, the client records session replays by default.
- Tailwind comes from `bunfig.toml`'s `[serve.static] plugins = ["bun-plugin-tailwind"]`. Bun
  bundles the page at runtime in dev (`bun --hot`) and production (`NODE_ENV=production`), so
  there's no build step and both run the same `bun src/server.ts`.

Run it locally with `hexclave dev -- bun --hot src/server.ts` (it injects the development
project's keys) and the backend running. To see it signed in without email codes, use
[scripts/dev-session.ts](scripts/dev-session.ts): it creates a test admin in the development
project and prints a `document.cookie` line to run in the page (works with browser automation).

### 4. Deploy

Add the service to the backend's deploy file (see [assets/hexclave.deploy.ts](assets/hexclave.deploy.ts)):

```ts
dashboard: {
  type: "serverless", public: true, ports: { 8080: { protocol: "http" } },
  memory: "1GB", minInstances: 0, maxInstances: 1,
  rootDirectory: ".", dockerfilePath: "infra/docker/dashboard.Dockerfile",
  env: {
    PORT: "8080",
    DASHBOARD_PERMISSION: "admin_dashboard",
    DASHBOARD_BACKEND_URL: isDev ? null : service("backend").url(3000),
    DASHBOARD_BACKEND_TOKEN: isDev ? null : secret("INTERNAL_API_TOKEN"),
    HEXCLAVE_PROJECT_ID: hexclave.projectId,
    HEXCLAVE_API_URL: hexclave.apiUrl,
    HEXCLAVE_SECRET_SERVER_KEY: hexclave.secretServerKey,
  },
},
```

- Same deployment group as the backend: `service("backend").url()` resolves when the dashboard
  deploys, and on GCP a `server` gets a new private IP on every redeploy, so the dashboard must
  redeploy whenever the backend does.
- `minInstances: 0` lets it sleep; the first visit after idle waits a few seconds while Bun
  starts and bundles the page.
- In a monorepo, `rootDirectory: "."` and `bun install --frozen-lockfile --filter <package>` in
  the Dockerfile ([assets/app/Dockerfile](assets/app/Dockerfile) is the single-package version).
  Deploy packaging leaves out anything in `.gitignore`.
- Then `hexclave deploy` (or push to the branch CI deploys). The CLI prints each service's URL.

### 5. One-time setup after the first deploy

```bash
bun scripts/admin-setup.ts --project <id> \
  --trusted-url https://<dashboard-url> \
  --admin alice@example.com --admin bob@example.com \
  --permission admin_dashboard --dry-run
```

Drop `--dry-run` to apply. It uses your `hexclave login` session, because both jobs need owner
rights:

- **Trusted domain.** Hosted sign-in only returns people to a trusted domain, and trusted domains
  are environment-level config: `hexclave config push` (branch level) can't set them. The script
  calls `project.updateConfig({ "domains.trustedDomains.<id>": { baseUrl, handlerPath: "/handler" } })`.
  Run it again whenever the dashboard's URL changes (a new custom domain, a new project).
- **Admin accounts.** With sign-up off, the script creates each account (verified email, email
  sign-in on) or finds it, and grants the project permission. Revoke in the Hexclave dashboard.

### 6. Verify

1. `GET /api/project` returns the project id; `GET /api/me` without a session says `signed-out`.
2. Open the URL: it redirects to Hexclave's sign-in page and comes back signed in. If it stops
   with a redirect error, the trusted domain is missing or has a different origin.
3. An account without the permission sees "not allowed", and `/api/<anything>` answers 403.
4. Use one read and one action, and check the backend's log line names the admin.

## Gotchas

[references/troubleshooting.md](references/troubleshooting.md) has symptoms and fixes. The ones
that cost the most time:

- Default config has no sign-in method; trusted domains and OAuth credentials are environment-level.
- The client finishes sign-in in its constructor; don't strip `code`/`state` from the URL first.
- `bun install` and npm can refuse a just-published `@hexclave/*` version under a minimum release
  age: use a range (`^1.0.125`), or exclude `@hexclave/*` from the age rule.
- Cloud Run answers `/healthz` itself, so don't use that path for your own health check.

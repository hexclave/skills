# Hexclave Skills

[![skills.sh](https://skills.sh/b/hexclave/skills)](https://skills.sh/hexclave/skills)

Agent Skills from [Hexclave](https://hexclave.com) for coding agents (Claude Code, Cursor, Codex, OpenCode, Gemini CLI and anything else that reads the [Agent Skills spec](https://agentskills.io)).

Skills are grouped by category under `skills/<category>/<skill-name>/`, each with its own `SKILL.md` and supporting files (for example `skills/deployments/` for Hexclave Deployments). This is the catalog layout the `skills` CLI discovers, and the same multi-skill style as [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) and [anthropics/skills](https://github.com/anthropics/skills).

## Install

With the [`skills`](https://github.com/vercel-labs/skills) CLI ([skills.sh](https://skills.sh)):

```bash
# see what's in the repo
npx skills add hexclave/skills --list

# install everything
npx skills add hexclave/skills

# install one skill
npx skills add hexclave/skills --skill hexclave-otel-clickhouse
```

Add `-g` to install for your user instead of the current project, and `-a claude-code` (or `cursor`, `codex`, ...) to pick an agent.

Claude Code plugin marketplace:

```
/plugin marketplace add hexclave/skills
/plugin install hexclave-deployments@hexclave-skills
```

## Skills

| Skill | What it does |
|---|---|
| [`hexclave-otel-clickhouse`](skills/deployments/hexclave-otel-clickhouse) | Self-hosted observability on Hexclave Deployments that replaces New Relic. Deploys ClickHouse, an OpenTelemetry Collector gateway (OTLP/HTTP with bearer-token auth) and an rrweb session-replay ingest service with a built-in player, then verifies them end to end. |
| [`hexclave-admin-dashboard`](skills/deployments/hexclave-admin-dashboard) | A private admin dashboard on Hexclave Deployments: Hexclave sign-in limited to a project permission, a Bun + React service that forwards to your private backend, the one-time trusted-domain and admin-account setup, and how to read and steer an AI agent's conversations from it. |

### hexclave-otel-clickhouse

Three services in one Hexclave deployment group:

- `clickhouse`: ClickHouse server, 8GB, always on, volume-backed, private only
- `otel-gateway`: OTel Collector contrib, OTLP/HTTP in, bearer tokens, disk-backed queue, public HTTPS
- `replay-ingest`: Bun service for rrweb chunks, session list and player, public HTTPS

It ships the deploy file, Dockerfiles, ClickHouse schema and retention scripts, a Node OTel bootstrap, a masked rrweb recorder, and a deploy script with dry-run, check, apply, verify, logs and pause/resume modes. Measured throughput, compression and sizing are in [`references/costs.md`](skills/deployments/hexclave-otel-clickhouse/references/costs.md).

You need a Hexclave project on a paid plan plus `HEXCLAVE_PROJECT_ID` and `HEXCLAVE_SECRET_SERVER_KEY`. Deploying creates billable resources.

### hexclave-admin-dashboard

One public `serverless` service added to your app's deployment group. It checks the Hexclave session and a `project` permission on every request and forwards allowed calls to `/internal/dashboard/*` on your private backend with a bearer token, so it never holds database credentials. It ships a typechecked Bun + React + Tailwind starter, the config and deploy snippets, a backend route skeleton, a script that sets the trusted domain and creates admin accounts with the permission, and a script that signs a browser into the development project for local testing.

You need a Hexclave project with Authentication, RBAC and Deploy, an existing private backend service, and `hexclave login` for the one-time setup.

## Validate

```bash
pip install skills-ref
agentskills validate skills/deployments/hexclave-otel-clickhouse
agentskills validate skills/deployments/hexclave-admin-dashboard
```

## Contributing

Add a folder under `skills/<category>/` (for example `skills/deployments/`) with a `SKILL.md` that follows the [spec](https://agentskills.io/specification) (`name` must match the folder name), add it to the table above, to `skills.sh.json` and to `.claude-plugin/marketplace.json`, and run the validator.

## License

[MIT](LICENSE)

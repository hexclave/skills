import { parseArgs } from "node:util";
import { HexclaveServerApp } from "@hexclave/js";

const { values } = parseArgs({
  options: {
    email: { type: "string", default: "dashboard-test@example.com" },
    permission: { type: "string" },
    "dev-project": { type: "string" },
  },
});
if (!values.permission) throw new Error("Pass --permission <id>.");

const projectId = process.env.HEXCLAVE_PROJECT_ID;
if (!projectId || !process.env.HEXCLAVE_SECRET_SERVER_KEY)
  throw new Error("Run inside `hexclave dev` (or export the development project's keys).");
// The permission grant outlives the session, so name the development project explicitly:
// production keys left in the shell must not get a test admin.
if (values["dev-project"] !== projectId)
  throw new Error(`Pass --dev-project ${projectId} to confirm it is a development project.`);

const app = new HexclaveServerApp({ tokenStore: null, urls: { default: { type: "hosted" } } });
const existing = (await app.listUsers({ query: values.email })).find(
  (u) => u.primaryEmail === values.email,
);
const user =
  existing ??
  (await app.createUser({
    primaryEmail: values.email,
    primaryEmailVerified: true,
    primaryEmailAuthEnabled: true,
  }));
await user.grantPermission(values.permission);
const session = await user.createSession({ expiresInMillis: 3_600_000 });
const { refreshToken } = await session.getTokens();
const value = encodeURIComponent(
  JSON.stringify({ refresh_token: refreshToken, updated_at_millis: Date.now() }),
);
console.log(
  `document.cookie = "hexclave-refresh-${projectId}--default=${value}; path=/; max-age=3600"`,
);

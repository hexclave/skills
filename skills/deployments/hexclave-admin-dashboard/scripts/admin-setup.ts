import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { HexclaveClientApp } from "@hexclave/js";

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    "trusted-url": { type: "string" },
    "trusted-id": { type: "string", default: "admin-dashboard" },
    admin: { type: "string", multiple: true, default: [] },
    permission: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const projectId = values.project ?? process.env.HEXCLAVE_PROJECT_ID;
if (!projectId) throw new Error("Pass --project <id> or set HEXCLAVE_PROJECT_ID.");
if (values.admin.length > 0 && !values.permission)
  throw new Error("Pass --permission <id> with --admin.");

const apiUrl = process.env.HEXCLAVE_API_URL ?? "https://api.hexclave.com";
const cliKey =
  process.env.STACK_CLI_PUBLISHABLE_CLIENT_KEY ?? "pck_9bbqvqsbh0gdb6smk11d71qg4ktc4rz8ya7cc69yndm7g";
const refreshToken =
  process.env.STACK_CLI_REFRESH_TOKEN ??
  JSON.parse(readFileSync(join(homedir(), ".config/hexclave/credentials.json"), "utf8"))
    .STACK_CLI_REFRESH_TOKEN;
if (!refreshToken) throw new Error("Run `hexclave login` first.");

const internal = new HexclaveClientApp({
  projectId: "internal",
  publishableClientKey: cliKey,
  baseUrl: apiUrl,
  tokenStore: { accessToken: "", refreshToken },
  noAutomaticPrefetch: true,
});
const owner = await internal.getUser({ includeRestricted: true });
if (!owner) throw new Error("The CLI session expired: run `hexclave login`.");
const project = (await owner.listOwnedProjects()).find((p) => p.id === projectId);
if (!project) throw new Error(`You don't own project ${projectId}.`);

const say = (line: string) => console.log(values["dry-run"] ? `[dry run] ${line}` : line);

if (values["trusted-url"]) {
  const baseUrl = new URL(values["trusted-url"]).origin;
  say(`trust ${baseUrl} (domains.trustedDomains.${values["trusted-id"]})`);
  if (!values["dry-run"])
    await project.updateConfig({
      [`domains.trustedDomains.${values["trusted-id"]}`]: { baseUrl, handlerPath: "/handler" },
    });
}

for (const email of values.admin) {
  const found = (await project.app.listUsers({ query: email })).find(
    (u) => u.primaryEmail?.toLowerCase() === email.toLowerCase(),
  );
  say(`${found ? "found" : "create"} ${email}, grant ${values.permission}`);
  if (values["dry-run"] || !values.permission) continue;
  const user =
    found ??
    (await project.app.createUser({
      primaryEmail: email,
      primaryEmailVerified: true,
      primaryEmailAuthEnabled: true,
    }));
  await user.grantPermission(values.permission);
  say(`${email}: ${(await user.hasPermission(values.permission)) ? "has" : "LACKS"} ${values.permission}`);
}

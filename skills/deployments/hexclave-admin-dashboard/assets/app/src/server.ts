import { HexclaveServerApp } from "@hexclave/js";
import { z } from "zod";
import page from "./index.html";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive(),
  HEXCLAVE_PROJECT_ID: z.string().min(1),
  HEXCLAVE_API_URL: z.url(),
  HEXCLAVE_SECRET_SERVER_KEY: z.string().min(1),
  DASHBOARD_PERMISSION: z.string().min(1),
  DASHBOARD_BACKEND_URL: z.url(),
  DASHBOARD_BACKEND_TOKEN: z.string().min(16),
});
const env = envSchema.parse(process.env);

const hexclave = new HexclaveServerApp({ tokenStore: null, urls: { default: { type: "hosted" } } });

const PRIVATE = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
const json = (body: Parameters<typeof Response.json>[0], status = 200) =>
  Response.json(body, { status, headers: PRIVATE });

async function viewer(request: Request) {
  const user = await hexclave.getUser({ tokenStore: request });
  if (!user) return { state: "signed-out" as const };
  const email = user.primaryEmail;
  if (!email || !user.primaryEmailVerified || !(await user.hasPermission(env.DASHBOARD_PERMISSION)))
    return { state: "denied" as const, email };
  return { state: "allowed" as const, email };
}

const BACKEND_PATH = /^\/api\/(orgs|orgs\/[\w-]+|items\/[\w-]+(\/[a-z]+)?)$/;

async function api(request: Request) {
  const url = new URL(request.url);
  const who = await viewer(request);
  if (url.pathname === "/api/me") return json(who);
  if (who.state === "signed-out") return json({ error: "Sign in first." }, 401);
  if (who.state === "denied") return json({ error: "Not allowed." }, 403);
  if (!BACKEND_PATH.test(url.pathname)) return json({ error: "Not found." }, 404);
  if (request.method !== "GET" && request.method !== "POST")
    return json({ error: "Method not allowed." }, 405);
  const upstream = await fetch(
    `${env.DASHBOARD_BACKEND_URL}${url.pathname.replace(/^\/api\//, "/internal/dashboard/")}${url.search}`,
    {
      method: request.method,
      headers: {
        authorization: `Bearer ${env.DASHBOARD_BACKEND_TOKEN}`,
        "content-type": "application/json",
        "x-dashboard-admin": who.email,
      },
      body: request.method === "POST" ? await request.text() : undefined,
      signal: AbortSignal.timeout(9_000), // under Bun.serve's 10 s idle timeout
    },
  ).catch(() => null);
  if (!upstream) return json({ error: "Backend unavailable." }, 502);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { ...PRIVATE, "content-type": "application/json" },
  });
}

const server = Bun.serve({
  port: env.PORT,
  hostname: "0.0.0.0",
  routes: {
    "/api/project": () =>
      json({ projectId: env.HEXCLAVE_PROJECT_ID, apiUrl: env.HEXCLAVE_API_URL }),
    "/api/*": api,
    "/*": page,
  },
});

console.info(`dashboard on ${server.url}`);

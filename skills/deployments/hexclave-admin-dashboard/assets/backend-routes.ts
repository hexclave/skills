import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

const TOKEN = process.env.DASHBOARD_API_TOKEN ?? "";
const ADMIN_HEADER = "x-dashboard-admin";
const PRIVATE = { "cache-control": "no-store" };

const idSchema = z.uuid();
const noteSchema = z.object({ text: z.string().trim().min(1).max(4_000) });

function fromDashboard(request: Request) {
  const given = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(TOKEN);
  return TOKEN.length >= 16 && given.length === expected.length && timingSafeEqual(given, expected);
}

const json = (body: Parameters<typeof Response.json>[0], status = 200) =>
  Response.json(body, { status, headers: PRIVATE });

export interface DashboardBackend {
  search(query: string): Promise<object[]>;
  item(id: string): Promise<object | null>;
  act(id: string, text: string, admin: string): Promise<{ status: string }>;
}

export function dashboardRoutes(backend: DashboardBackend) {
  return async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/internal/dashboard/")) return null;
    if (!fromDashboard(request)) return json({ error: "unauthorized" }, 401);
    const admin = request.headers.get(ADMIN_HEADER) ?? "unknown";

    if (request.method === "GET" && url.pathname === "/internal/dashboard/orgs")
      return json({ orgs: await backend.search(url.searchParams.get("q") ?? "") });

    const item = /^\/internal\/dashboard\/items\/([^/]+)(\/act)?$/.exec(url.pathname);
    const id = idSchema.safeParse(item?.[1]).data;
    if (!item || !id) return json({ error: "not found" }, 404);

    if (request.method === "GET" && !item[2]) {
      const found = await backend.item(id);
      return found ? json(found) : json({ error: "not found" }, 404);
    }
    if (request.method === "POST" && item[2]) {
      const body = noteSchema.safeParse(await request.json().catch(() => null));
      if (!body.success) return json({ error: "bad request" }, 400);
      console.info("[dashboard] act", id, admin);
      return json(await backend.act(id, body.data.text, admin));
    }
    return json({ error: "method not allowed" }, 405);
  };
}

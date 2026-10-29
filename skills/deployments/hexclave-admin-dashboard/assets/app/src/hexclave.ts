import { HexclaveClientApp } from "@hexclave/js";
import { z } from "zod";

const projectSchema = z.object({ projectId: z.string(), apiUrl: z.url() });
const errorSchema = z.object({ error: z.string() });

export const viewerSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("signed-out") }),
  z.object({ state: z.literal("denied"), email: z.string().nullable() }),
  z.object({ state: z.literal("allowed"), email: z.string() }),
]);

let app: Promise<HexclaveClientApp> | undefined;

export function hexclaveApp() {
  app ??= fetch("/api/project")
    .then((response) => response.json())
    .then((body) => {
      const project = projectSchema.parse(body);
      return new HexclaveClientApp({
        projectId: project.projectId,
        baseUrl: project.apiUrl,
        tokenStore: "cookie",
        urls: { default: { type: "hosted" } },
        analytics: { enabled: false, replays: { enabled: false } },
        devTool: false,
      });
    });
  return app;
}

export const signIn = async () => (await hexclaveApp()).redirectToSignIn();
export const signOut = async () => (await hexclaveApp()).signOut();

export async function call<S extends z.ZodType>(schema: S, path: string, body?: Record<string, string>) {
  const authorization = await (await hexclaveApp()).getAuthorizationHeader();
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(authorization && { authorization }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const parsed: unknown = await response.json().catch(() => null);
  if (response.status === 401) await signIn();
  if (!response.ok)
    throw new Error(errorSchema.safeParse(parsed).data?.error ?? response.statusText);
  return schema.parse(parsed);
}

export const me = () => call(viewerSchema, "/api/me");

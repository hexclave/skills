// Server-side gate for a private dashboard on TanStack Start: every server function checks the
// Hexclave session cookie and an email allowlist before it touches ClickHouse, and answers
// Cache-Control: private, no-store. Pair it with your own sign-in form that calls
// hexclaveClientApp.signInWithCredential({ email, password, noRedirect: true }), so no hosted
// redirect or /handler route is involved.
import { HexclaveServerApp } from "@hexclave/tanstack-start";
import { createMiddleware } from "@tanstack/react-start";
import { getRequest, setResponseHeader, setResponseStatus } from "@tanstack/react-start/server";

export type Viewer =
  | { state: "signed-out" }
  | { state: "denied"; email: string | null }
  | { state: "allowed"; email: string };

let app: HexclaveServerApp | null = null;

function serverApp() {
  if (app) return app;
  const projectId = process.env.HEXCLAVE_PROJECT_ID;
  const secretServerKey = process.env.HEXCLAVE_SECRET_SERVER_KEY;
  if (!projectId || !secretServerKey) throw new Error("HEXCLAVE_PROJECT_ID and HEXCLAVE_SECRET_SERVER_KEY must be set");
  app = new HexclaveServerApp({ projectId, secretServerKey, tokenStore: null, urls: { default: { type: "hosted" } } });
  return app;
}

function allowedEmails(): Set<string> {
  return new Set(
    (process.env.DASHBOARD_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function currentViewer(): Promise<Viewer> {
  // tokenStore: the incoming request, so the session cookie is read on the server.
  const user = await serverApp().getUser({ tokenStore: getRequest() });
  if (!user) return { state: "signed-out" };
  const email = user.primaryEmail?.trim().toLowerCase() || null;
  if (!email || !user.primaryEmailVerified || !allowedEmails().has(email)) return { state: "denied", email };
  return { state: "allowed", email };
}

const noStore = createMiddleware({ type: "function" }).server(async ({ next }) => {
  setResponseHeader("Cache-Control", "private, no-store");
  return next();
});

// Use on every createServerFn that reads data: createServerFn(...).middleware([requireAllowed])
export const requireAllowed = createMiddleware({ type: "function" })
  .middleware([noStore])
  .server(async ({ next }) => {
    const viewer = await currentViewer();
    if (viewer.state !== "allowed") {
      setResponseStatus(viewer.state === "signed-out" ? 401 : 403);
      throw new Error(viewer.state === "signed-out" ? "Sign in required" : "Not allowed");
    }
    return next({ context: { email: viewer.email } });
  });

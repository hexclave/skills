import "./styles.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { z } from "zod";
import { me, signIn, signOut, type viewerSchema } from "./hexclave.ts";

type Viewer = z.infer<typeof viewerSchema>;

function App() {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    me().then(
      (who) => (who.state === "signed-out" ? void signIn() : setViewer(who)),
      (error: Error) => setFailure(error.message),
    );
  }, []);

  if (failure) return <p className="p-8 text-red-700">{failure}</p>;
  if (!viewer || viewer.state === "signed-out") return <p className="p-8">Signing you in…</p>;
  if (viewer.state === "denied")
    return (
      <div className="p-8">
        <p>{viewer.email ?? "This account"} isn't allowed here.</p>
        <button type="button" className="mt-4 underline" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    );
  return (
    <div className="p-8">
      <p>Signed in as {viewer.email}.</p>
      <p className="mt-2 text-sm text-gray-500">Build the dashboard here: call your backend with call() from ./hexclave.ts.</p>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("The page has no root.");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Minimal replay viewer. rrweb-player is pinned and self-contained (no bare imports).
// The read token is passed in the URL fragment (#token=...), which browsers never send to the server.
const PLAYER_VERSION = "2.1.7";

export function playerHtml(project: string, session: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Replay ${session}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/rrweb-player@${PLAYER_VERSION}/dist/style.css">
<style>body{font-family:system-ui;margin:16px;background:#f6f6f6}#status{margin:8px 0;color:#555}</style>
</head><body>
<div id="status">loading ${session}...</div><div id="player"></div>
<script type="module">
import rrwebPlayer from "https://cdn.jsdelivr.net/npm/rrweb-player@${PLAYER_VERSION}/dist/rrweb-player.js";
const token = new URLSearchParams(location.hash.slice(1)).get("token");
const status = document.getElementById("status");
const res = await fetch("/v1/replay/sessions/${project}/${session}/events", { headers: { Authorization: "Bearer " + token } });
if (!res.ok) { status.textContent = "failed: " + res.status; throw new Error("load failed"); }
const events = await res.json();
status.textContent = events.length + " events";
window.__replayEvents = events.length;
window.__player = new rrwebPlayer({ target: document.getElementById("player"), props: { events, autoPlay: true, width: 1024, height: 576 } });
window.__replayReady = true;
</script></body></html>`;
}

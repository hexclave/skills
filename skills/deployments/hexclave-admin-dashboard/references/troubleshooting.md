# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Hosted sign-in page offers no way to sign in | Every sign-in method defaults to off | `auth: { otp: { allowSignIn: true } }` (or another method) in `hexclave.config.ts`, then `hexclave config push` |
| After signing in, a redirect error instead of the dashboard | The dashboard's origin isn't a trusted domain | `scripts/admin-setup.ts --trusted-url <url>`. Trusted domains are environment config: `hexclave config push` can't set them |
| `"auth.otp" does not exist in type` when typechecking the config | `defineHexclaveConfig` typing in 1.0.125 | Use the nested form `auth: { otp: { allowSignIn: true } }` |
| `has a deploy export` from `hexclave config push` | Services live in the deploy file, not the config | Keep `hexclave.config.ts` and `hexclave.deploy.ts` separate |
| Signed in but every call says "Not allowed" | Account lacks the permission, or its primary email isn't verified | Grant it (`admin-setup.ts --admin <email> --permission <id>`); created accounts are marked verified |
| Signed in, then sent back to sign in on every call | The page didn't send `Authorization`, or the server read the wrong token store | Send `getAuthorizationHeader()`; read with `getUser({ tokenStore: request })` |
| Sign-in loops right after returning from the hosted page | The URL's `code`/`state` (or `hexclave_cross_domain_*`) parameters were stripped before the client was constructed | Construct `HexclaveClientApp` on page load, before any router rewrites the URL |
| Session replays of admin screens in Hexclave Analytics | The client records replays by default when the Analytics app is on | `analytics: { enabled: false, replays: { enabled: false } }` |
| A "Hexclave Dev Tools" button on the page | Dev tools default on in development | `devTool: false` |
| Dashboard can't reach the backend (connection refused, timeouts) | Backend is a private `serverless` service on GCP, or it redeployed after the dashboard and changed IP | Make the backend a `server`; redeploy the dashboard after the backend, in the same group |
| `Invalid project ID` at startup | `HEXCLAVE_PROJECT_ID` isn't a UUID | Pass `hexclave.projectId` in the deploy file |
| `minimum release age` refusing `@hexclave/js` | npm or Bun `minimumReleaseAge` | Use a range, or exclude `@hexclave/*` from the rule |
| Page loads without styles in production | Tailwind plugin not configured for `Bun.serve` HTML imports | `bunfig.toml`: `[serve.static] plugins = ["bun-plugin-tailwind"]`, next to `package.json` |
| First request after idle takes several seconds | `minInstances: 0`: start-up plus Bun bundling the page | Accept it, or `minInstances: 1` (billed always on) |
| `/healthz` returns 404 | Cloud Run reserves it | Use another path |
| Files missing from the image | Deploy packaging skips `.gitignore`d files | Don't depend on ignored files, or un-ignore them in `.dockerignore` |

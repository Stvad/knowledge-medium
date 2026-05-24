# Domain onboarding

Checklist for moving from `localhost` to a production domain. Work through it once per new environment; treat each section as independently verifiable.

Throughout, replace `your-domain.com` with the real hostname.

---

## 1. Env vars (set in your hosting platform's secrets UI)

All four are required at build time — Vite inlines them into the bundle.

| Var | Holds | Where it's read |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL | [src/services/supabase.ts:4](../src/services/supabase.ts) |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key | same |
| `VITE_POWERSYNC_URL` | PowerSync instance URL | [src/services/powersync.ts:11](../src/services/powersync.ts) |
| `VITE_GOOGLE_MAPS_API_KEY` | Google Maps + Places (New) key | [src/plugins/geo/googlePlacesClient.ts](../src/plugins/geo/googlePlacesClient.ts) (`resolveApiKey`) |

Optional:

| Var | Default | When to set |
|---|---|---|
| `APP_BASE_PATH` | `/` | Deploying under a subpath (e.g. `/app/`) — read in [vite.config.ts](../vite.config.ts) |
| `VITE_AGENT_RUNTIME_URL` | `http://127.0.0.1:8787` (dev fallback in [src/plugins/agent-runtime/bridge.ts:8](../src/plugins/agent-runtime/bridge.ts)) | When the agent server is hosted somewhere other than the user's laptop |

---

## 2. Supabase

### In-repo
- [supabase/config.toml](../supabase/config.toml) lines 4–10 — `site_url` and `additional_redirect_urls`. These drive the local Supabase CLI; if you only deploy via the hosted dashboard you can leave them at localhost for dev convenience, but the dashboard settings (below) are what production uses.

### Dashboard (out-of-repo)
- **Authentication → URL Configuration**:
  - **Site URL**: `https://your-domain.com`
  - **Redirect URLs** (allow-list): add `https://your-domain.com/**`. Keep the existing localhost entries while you still need dev auth to work; remove them when you no longer use Supabase auth from `localhost`.
- If you use magic-link or OAuth: the redirect must match an entry exactly (including trailing slash).

### Verify
Sign in from production once. If you land on a localhost URL after clicking a magic link, the dashboard Site URL is still pointing at the old environment.

---

## 3. PowerSync

### Dashboard (out-of-repo)
- **Settings → Allowed Origins**: add `https://your-domain.com`. Without this the WebSocket sync connection will be rejected with a CORS-shaped error in the browser console.
- Keep the JWT issuer config in sync with Supabase (this is one-time at PowerSync project creation, not per-domain — verify it didn't drift).

### Verify
Open the app on the new domain, watch the sync-status indicator turn green within a couple seconds. Network tab: `wss://…powersync.journeyapps.com/sync/stream` connects with 101.

---

## 4. Google Maps + Places API

### GCP console (out-of-repo)
Walk through `docs/domain-onboarding.md` section 4 once per environment.

- **APIs & Services → Credentials → click your API key**:
  - **Application restrictions → Websites**: add `https://your-domain.com/*` (with the wildcard). Keep `http://localhost:5173/*` while you still need dev to work; remove eventually.
  - **API restrictions**: confirm only `Maps JavaScript API` and `Places API (New)` are enabled — these are the only ones the geo plugin uses.

### Verify
- `@dandelion` in any block returns Google suggestions within ~300ms.
- Locations page renders the map without the "For development purposes only" watermark.
- A 403 or `REQUEST_DENIED` in the network tab → referrer pattern doesn't match.

### Optional: custom map style
The map currently uses `DEMO_MAP_ID` (hardcoded in [src/plugins/geo/MapView.tsx](../src/plugins/geo/MapView.tsx)). For a styled / branded map, create a Map ID at https://console.cloud.google.com/google/maps-apis/studio/maps and swap the constant in `MapView.tsx`. (Same fix applies to the drop-pin map in [src/plugins/geo/LocationPropertyEditor.tsx](../src/plugins/geo/LocationPropertyEditor.tsx).)

---

## 5. Things that DON'T need updating

These were audited and confirmed domain-agnostic — no action needed:

- **PWA manifest** ([public/manifest.webmanifest](../public/manifest.webmanifest)) — uses relative URLs (`.` for `start_url` and `scope`).
- **Service worker** ([public/sw.js](../public/sw.js), [src/registerServiceWorker.ts](../src/registerServiceWorker.ts)) — uses `self.registration.scope` and `import.meta.env.BASE_URL`.
- **Supabase / PowerSync client construction** — both read from env vars, no hardcoded URLs.
- **Google Places API base URL** (`https://places.googleapis.com/v1`) — Google's endpoint, fixed.
- **CDN imports in [index.html](../index.html)** — `https://esm.sh` with SRI hashes; intentional.
- **Localhost in tests** ([src/utils/test/safeMode.test.ts](../src/utils/test/safeMode.test.ts)) — fixtures, not runtime.

---

## 6. Optional but worth doing before launch

These aren't blockers; flag them when you have time.

- **Security headers**: no `vercel.json` / `netlify.toml` / `_headers` exists in this repo. Whatever you deploy on, set at minimum `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`. If you go the CSP route, allow `https://maps.googleapis.com`, `https://places.googleapis.com`, `https://*.gstatic.com`, your Supabase host, and your PowerSync host.
- **OG / canonical metadata** in [index.html](../index.html) — currently no `<meta property="og:url">` or `<link rel="canonical">`. Add them with the production domain if you care about social previews or SEO.
- **Deploy config file** — no `vercel.json` / `netlify.toml` / `wrangler.toml` exists. Whichever platform you pick, commit its config so this onboarding doc has a concrete spot to point at next time.

---

## Quick "is it deployed right?" smoke test

After flipping a new environment live, run through this in under 5 minutes:

1. Open the site on the new domain in an incognito window.
2. Sign in (Supabase auth round-trip).
3. Watch sync-status go green (PowerSync WebSocket).
4. In any block, type `@dandelion chocolate` → see a Google suggestion.
5. Pick the suggestion → confirm a Place block lands under the Locations page.
6. Open Locations → confirm the map renders with the pin (no watermark).
7. Add a `location` property on a different block → pick the same Place → confirm reference.

Any failure narrows to one of the sections above.

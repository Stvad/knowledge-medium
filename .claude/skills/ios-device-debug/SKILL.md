---
name: ios-device-debug
description: Reproduce and debug iOS-only web bugs (iPhone/iPad Safari & Chrome) from the Mac — drive the live device's real iOS WebKit with scripted JS, console capture, and DOM inspection over a Tailscale HTTPS tunnel + ios-webkit-debug-proxy. Use when a bug reproduces on iOS but NOT in Playwright WebKit or on desktop — especially native-input bugs (beforeinput, soft keyboard, IME/composition, touch, visualViewport, scroll), service-worker/PWA, or anything you suspect is iOS-WebKit-specific. Also covers the iOS Simulator path. NOT needed for ordinary mobile-layout checks (use Playwright WebKit with an iPhone descriptor for those).
---

# Debugging iOS-only web bugs from the Mac

## The one fact that makes this tractable

**On iOS every browser is WebKit.** Apple forces Chrome, Firefox, Edge — all of them — onto WKWebView. "Chrome on iPhone" is a WebKit engine in a Chrome skin. So an iOS bug is a WebKit bug and reproduces in WebKit on the Mac. You rarely need the exact device — but some bugs do.

### Pick the cheapest tier that can reproduce it

| Tier | Reproduces | Misses | I can drive it? |
|------|-----------|--------|-----------------|
| **Playwright WebKit** + iPhone descriptor | WebKit CSS/layout, JS-engine (JSC) differences, touch | iOS soft keyboard, `visualViewport` collapse, **native-input quirks** (beforeinput doubling, IME), exact iOS build | fully scripted, ~70 MB |
| **iOS Simulator** (Mobile Safari) | real iOS WebKit, soft keyboard, `visualViewport` | iwdp can't see it (no scripted DOM); Chrome-toolbar chrome | navigate + screenshots only (`simctl`) |
| **Real device** (this skill) | everything, incl. native input fidelity | — | **fully scripted** via remote inspector |

Rule of thumb: **bug repros on iOS but not Playwright WebKit → go straight to the real device.** That asymmetry usually means a native-input or exact-engine quirk Playwright can't emulate.

---

## Real-device loop (the main tool)

End state: `node ios.mjs eval '<js>'` runs arbitrary JS in the live iPad/iPhone Safari tab; `node ios.mjs console <secs>` streams its console. The bundled [`ios.mjs`](ios.mjs) handles the protocol.

### One-time host setup

```bash
brew install tailscale ios-webkit-debug-proxy
sudo brew services start tailscale     # daemon (Homebrew formula isn't the GUI app)
tailscale up                           # browser login
```
Then in the Tailscale **admin console** (login.tailscale.com/admin/dns) enable **MagicDNS** *and* **HTTPS Certificates** (serve needs a cert).

### Per-session setup

**1. Secure-context tunnel.** The app needs WebCrypto + service worker + OPFS → a **secure context**. `https://` and `http://localhost` qualify; `http://<LAN-IP>` does **not** (the app boots then breaks). A real device can't use `localhost`, so tunnel HTTPS in:

```bash
tailscale serve --bg http://localhost:5173
```
- Target the **`localhost` hostname, not `127.0.0.1`.** Vite dev binds `[::1]:5173` (IPv6-only); serve's IPv4 default → `502`, and a bracketed `[::1]` literal → serve mangles it (`unknown proxy destination`). `localhost` resolves to `::1` and works.
- Add `server.allowedHosts: ['.ts.net']` to `vite.config.ts` or the tunnel host gets **"Blocked request"** (Vite's DNS-rebinding guard). **Dev-only — don't commit it.**
- Sanity-check from the Mac (Homebrew `tailscaled` doesn't wire MagicDNS into the macOS resolver, so force-resolve):
  ```bash
  curl -s --resolve <your-machine>.<tailnet>.ts.net:443:$(tailscale ip -4 | head -1) \
    https://<your-machine>.<tailnet>.ts.net/ -o /dev/null -w '%{http_code}\n'   # want 200
  ```
  The device resolves the `*.ts.net` name natively via its Tailscale app.

**2. Device.** Install the Tailscale app, sign into the **same tailnet**, toggle on. Settings → Display & Brightness → **Auto-Lock → Never**. Settings → Safari → Advanced → **Web Inspector → ON**. Open the `https://<your-machine>.<tailnet>.ts.net/` URL in **Safari** (see "Inspect in Safari" below).

**3. Proxy.** Run in the background:
```bash
ios_webkit_debug_proxy -c null:9221,:9222-9322 -F
```
Confirm: `curl -s localhost:9221/json` lists the device; `node ios.mjs pages` lists its Safari tabs.

### Use it
[`ios.mjs`](ios.mjs) needs **Node ≥22** (uses global `WebSocket` + `fetch` + top-level await).
```bash
node ios.mjs eval '<expr or async IIFE>'   # returns the value (JSON for objects)
node ios.mjs console <seconds>             # stream console while you reproduce
node ios.mjs pages                         # list inspectable tabs
```
Override the tab match (default `ts.net`) with `MATCH=<substr>`.

---

## Gotchas that will waste your time if you don't know them

- **ios-webkit-debug-proxy sees REAL DEVICES ONLY, never the Simulator.** Device list at `:9221/json`, per-device tab list at `:9222/json`.
- **Only the FOREGROUND, AWAKE tab is inspectable.** Lock the device or background Safari and the tab vanishes (`pages` → 0, target never announces). Auto-Lock → Never is not optional for a real session.
- **Inspect in Safari, not Chrome.** iwdp only exposes Safari tabs (and apps that opt their WKWebView into `isInspectable`); Chrome-iOS tabs generally don't appear. Same WebKit engine, so a true *engine* bug repros in Safari too. If it repros in Chrome but **not** Safari, that's a Chrome-iOS-skin issue (toolbar/`innerHeight`) — a different animal.
- **iOS 26 uses the multi-target inspector protocol.** Bare `Runtime.evaluate` → `"'Runtime' domain was not found"`. You must wait for `Target.targetCreated` (prefer `type:'page'`) and wrap every command in `Target.sendMessageToTarget` / unwrap `Target.dispatchMessageFromTarget`. `ios.mjs` does this.
- **Inline `awaitPromise` is ignored on iOS** (returns `{}`). `ios.mjs` works around it: evaluate `Promise.resolve((expr))` with `returnByValue:false`, then `Runtime.awaitPromise` on the objectId. So you can pass async IIFEs freely.
- **iPad presents a desktop UA** (`Macintosh … Safari`) because of desktop-class browsing → UA/mobile sniffing treats it as desktop. **iPad ≠ iPhone for UA-sensitive code.** Test an iPhone if the bug is UA-gated.
- **Synthetic events ≠ native input.** A JS-dispatched `keydown`/`beforeinput` will **not** reproduce native-input quirks (the very bugs you came for). Instrument via JS, but **trigger via a physical press by the user.** This is the whole reason the device is in the loop.
- `swControlled` is `false` in dev — vite doesn't register the service worker.
- `preventDefault()` on **keydown** is ignored by iOS for many keys; on **`beforeinput`** it IS honored. Fixes for native-input bugs belong at the `beforeinput` layer.

---

## Diagnostic patterns that worked

- **Capture the event sequence.** Install capture-phase listeners for `keydown`/`beforeinput`/`input` into a `window.__ev` buffer, have the user do the gesture once, then read the buffer. Reveals double-fires and which `inputType` actually drives the change.
- **A/B guard experiment on-device.** To isolate which path inserts/mutates, install a listener that `preventDefault()`s a *candidate* cause, have the user reproduce, and measure the delta. (We proved a native `insertLineBreak` was the *sole* inserter by suppressing it and seeing zero change.)
- **Measure structurally, not visually.** e.g. count `.cm-line` elements in the focused `.cm-editor` to count newlines; read `.cm-content` text; inspect app state via the data layer.
- **Validate the fix live.** Edit code → `node ios.mjs eval '(() => { setTimeout(() => location.reload(), 50); return "reloading" })()'` (vite serves fresh modules) → user does the physical gesture once → re-measure. Then `yarn run check` and commit. Keep the unit test as the regression guard (native-only bugs won't be caught by jsdom/Playwright, but the *handler* behavior is testable — dispatch a synthetic `beforeinput` at the CM `contentDOM`; mark the file `// @vitest-environment jsdom`).

## Teardown
```bash
tailscale serve reset                  # tears down the serve config (no `off` keyword in current Tailscale)
pkill -f ios_webkit_debug_proxy
git checkout vite.config.ts            # drop the temporary allowedHosts tweak
```

---

## iOS Simulator path (when you want a quick visual check without a device)

Real iOS WebKit with a working soft keyboard / `visualViewport`, served over secure `localhost` — but **not scriptable via iwdp**. Good for layout/keyboard eyeballing.

```bash
xcodebuild -downloadPlatform iOS            # one-time, ~7 GB; needs free disk
xcrun simctl boot 'iPhone 16'; open -a Simulator
xcrun simctl openurl booted http://localhost:5173      # localhost = secure context, works
xcrun simctl io booted screenshot /tmp/sim.png         # readable screenshot
```
- **Software keyboard:** Simulator menu **I/O → Keyboard → Connect Hardware Keyboard OFF** (⇧⌘K) so it auto-appears on focus; ⌘K toggles it. A field must be focused.
- DOM/console: desktop **Safari → Develop → Simulator → [page]** (manual; iwdp can't reach the sim).

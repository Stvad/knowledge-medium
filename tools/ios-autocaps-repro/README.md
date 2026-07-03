# iOS autocaps / `pendingIOSKey` repro

A **minimal, standalone CodeMirror 6** page (no knowledge-medium app code) to answer one
question on a real iOS device:

> When you `preventDefault()` an Enter / Backspace / Delete keydown **and move the DOM
> selection programmatically**, does iOS's soft keyboard get stuck in the wrong
> (lowercase) auto-capitalization state?

That WebKit behavior is the reason `@codemirror/view` defers those keys on iOS
(`pendingIOSKey` / `flushIOSKey`, `node_modules/@codemirror/view/dist/index.js`), which is
in turn the root cause of the split-instead-of-accept bug fixed in this repo's PR #299
(`src/utils/codemirror.ts` `acceptCompletionBeforeIOSDefer`). Origin: `codemirror/dev`
[#165](https://github.com/codemirror/dev/issues/165) and
[#433](https://github.com/codemirror/dev/issues/433). If the WebKit bug is fixed on current
iOS, CM could gate the deferral behind a version check and our app-level workaround could be
dropped.

## What the page does

Two CodeMirror editors, seeded identically per scenario:

- **CONTROL** — a bare `EditorView`. On iOS its Enter/Backspace/Delete go through CM's real
  `pendingIOSKey` path (native key allowed through, no `preventDefault`). This is the
  "workaround ON" baseline — autocaps should work.
- **TEST** — same editor + a capture-phase interceptor that `preventDefault()`s
  Enter/Backspace/Delete and applies the edit via a CM transaction, which writes the new DOM
  selection programmatically. This reproduces the **pre-kludge** behavior (workaround
  REMOVED) — the exact "a script moves the DOM selection" condition from #165.

Pick a scenario, do the steps **in each editor with the on-screen keyboard**, and read the
result. The verdict is objective: it's whatever character the soft keyboard actually
inserted — an uppercase letter means autocaps fired, lowercase means it was frozen.

Scenarios: **Enter** and **Backspace** are the real soft-keyboard autocaps cases (from
#433/#165). **Delete** (forward) isn't on the soft keyboard and autocaps is a soft-keyboard
feature, so it's a hardware-keyboard sanity probe only, not a true autocaps case.

## Run it on a device

Needs Node ≥ 22 (for `serve.mjs`). First populate `vendor/` (gitignored), then serve:

```bash
node tools/ios-autocaps-repro/sync-vendor.mjs        # copy real CM ESM out of node_modules
node tools/ios-autocaps-repro/serve.mjs              # static server on http://localhost:5178
```

Then follow the repo's on-device loop (`.claude/skills/ios-device-debug/`):

```bash
tailscale serve --bg http://localhost:5178           # secure https://<machine>.ts.net tunnel
ios_webkit_debug_proxy -c null:9221,:9222-9322 -F    # remote inspector bridge
```

Open `https://<machine>.ts.net/` in **Safari** on the device (foreground, awake, Web
Inspector ON). Drive/inspect from the Mac:

```bash
node .claude/skills/ios-device-debug/ios.mjs eval 'JSON.stringify(window.snap())'
node .claude/skills/ios-device-debug/ios.mjs eval 'JSON.stringify(window.__env)'
node .claude/skills/ios-device-debug/ios.mjs eval 'JSON.stringify(window.__log.slice(-20))'
```

Synthetic key events do **not** reproduce native soft-keyboard input — a human must
physically type. The page exposes `window.CTRL`, `window.TEST`, `window.snap()`,
`window.__env`, `window.__log`, and `window.setScenario(name)` for the bridge.

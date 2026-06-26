# `Clear-Site-Data` spike — can a service worker trigger an origin wipe?

> **Status:** verified · ran against Chromium 141 on 2026-06-23. CODE + this run
> are authoritative; re-run `run.js` to re-verify on a newer engine.
> **Last verified against code:** 2026-06-23.

Context: [`../lock-and-wipe-coarse-recommendation.md`](../lock-and-wipe-coarse-recommendation.md)
§0.3. The recommended "panic wipe" is to delegate to the browser's own
`Clear-Site-Data` clearing. That header must come from **our origin's
response**, but the app ships on **GitHub Pages**, which can't set custom
response headers. The open question this spike answers: **can a service worker
fill that gap by emitting the header itself?**

## What it tests

A tiny local HTTP server (on `127.0.0.1`, a secure context, so SW +
`Clear-Site-Data` both work over plain HTTP) seeds every storage bucket
(localStorage, sessionStorage, cookie, IndexedDB, Cache API, OPFS, and a
registered service worker), then clears via four delivery paths and re-inventories
after a reload:

| Case | How `Clear-Site-Data: "cache","cookies","storage"` is delivered |
| --- | --- |
| **A1** | SW *synthesizes* the response: `respondWith(new Response('', {headers}))` |
| **A2** | SW *passes through* a real network response: `respondWith(fetch('/network-clear'))` |
| **B**  | page `fetch()` of a real network response (no SW interception) |
| **C**  | top-level navigation to a real network response |

Driven by Playwright in fully ephemeral, in-memory browser contexts (one per
case) — it never touches a real/persistent browser profile.

## Result (Chromium 141)

| Case | Outcome |
| --- | --- |
| **A1** SW-synthesized | **IGNORED — nothing cleared** |
| **A2** SW pass-through | all cleared |
| **B** network fetch | all cleared |
| **C** navigation | all cleared |

**Conclusion:** Chromium only honors `Clear-Site-Data` on responses that
**actually came over the network**; a SW-fabricated `Response` is dropped. The
real blocker is the network-origin requirement — **not** self-reference: A2 also
unregisters the very SW that produced the response, and it still clears
everything. But A2/B/C all require **our origin's server** to emit the header,
which GitHub Pages won't. So on GH Pages there is no SW workaround; a true
one-click trigger needs a header-capable host.

Only Chromium was exercised (the only engine installed here). The spec does not
require honoring synthesized responses, so other engines are unlikely to be more
permissive — but that's unverified.

## Re-running

```sh
cd docs/clear-site-data-spike
npm install playwright-core   # match the installed browser revision
node run.js                   # prints JSON; see results.json for a captured run
```

`run.js` points `executablePath` at a pre-installed Chromium; adjust the path (or
drop it to let Playwright resolve its own bundled browser) for your environment.

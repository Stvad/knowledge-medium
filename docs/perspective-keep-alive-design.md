# Perspective keep-alive — sessions-per-perspective + a warm session host

> **Status:** proposed — design only, nothing built.
> Last verified against code: 2026-07-10 (src/ + agent-extensions/window-management/ @ working tree).

Switching perspectives (window-management extension) currently unmounts and
remounts every pane's React tree — a playing video restarts, editors lose
transient state, heavy views (agenda) pay full re-mount cost. Goal: switching
a perspective keeps every other perspective's views fully alive, so coming
back finds them exactly as left — playback still running.

Secondary goal: this is a step toward upstreaming the perspectives extension
(today it lives in spolakh's fork as `agent-extensions/window-management/` —
emacs-style panes, numbered + per-item perspectives, a bottom workspace bar).
The extension stays an extension; the enabling mechanism lands in core as a
generic, self-contained feature ("switchable layout sessions with keep-alive")
that others could build tab-like UX on.

## Why switching remounts today

A perspective switch never swaps trees — it **rewrites the single live
layout-session block in place**. `applyPerspective`
(`agent-extensions/window-management/index.tsx`) calls `reconcilePanelRows`
(`src/utils/panelLayoutProjection.ts:405`), which LCS-diffs panel rows by
`topLevelBlockId`. Across perspectives the block ids are disjoint, so one of
two things happens, and both destroy the mounted content:

1. **Row reused, content rewritten** (equal pane counts — the common case):
   the panel row id — the React `key` at
   `src/components/renderer/LayoutRenderer.tsx:92` — stays stable, but
   `topLevelBlockIdProp` flips, so `PanelRenderer`'s inner
   `<BlockComponent blockId={topLevelBlockId}/>`
   (`src/components/renderer/PanelRenderer.tsx:192`, no key) reconciles to a
   different block and the whole content subtree unmounts.
2. **Row deleted/created** (pane counts differ): `tx.delete` /
   `createPanelRowInTx` → new row id → new `key` → the entire
   `PanelSlotView` unmounts.

The perspective snapshot (`storage.ts`, per-device localStorage) stores only
content identity — a serialized layout hash of block ids + tree shape, plus
`activeBlockId`. There is no handle to a live view to come back to. Keep-alive
cannot be bolted onto this model; "one session, rewritten in place" is the
specific thing defeating it.

## Design: perspective = its own layout-session block

Flip the model. Each perspective owns a **distinct layout-session block**;
switching changes *which session is visible*. The outgoing perspective's rows,
scroll, focus, and React tree are never touched — keep-alive falls out of the
data model instead of being retrofitted.

### Core half — `LayoutSessionHost`

- **Switchable active session id.** `src/utils/layoutSessionId.ts` currently
  yields one per-device id (sessionStorage in a tab, localStorage installed).
  Add a runtime-switchable *active session id* (module store à la
  `createToggleStore`, persisted per-device), defaulting to today's single
  id — zero behavior change when nothing drives it.
- **Warm-set host.** `src/App.tsx:306` mounts exactly one
  `<BlockComponent blockId={layoutSessionBlock.id}/>`. Replace with a
  `LayoutSessionHost` that keeps an LRU set of recently-active session blocks
  mounted (cap ~3, configurable), each under a stable
  `key={sessionBlockId}`, inactive ones wrapped in `display:none`. Set
  membership stable → no remount → playback continues.
- **URL projection binds to the active session only.**
  `PanelLayoutProjection` (`src/utils/panelLayoutProjection.ts:584`) keeps
  rows ↔ URL hash in sync bidirectionally and pushes a hash entry on every
  layout change. Hidden sessions must not push; on switch, rebind (or select
  among per-session instances) and push the new session's layout hash once.
  Keeps the maximize/restore `history.back()` leg working.
- **Input isolation** — the subtle correctness area. Keybind dispatch and
  "active panel" resolution must resolve through the active *session*; hidden
  sessions' shortcut surfaces must be gated off (e.g. a `sessionHidden`
  context flag checked by dispatch/activations). Each session carries its own
  `activePanelIdProp`, so without gating, two sessions both believe they have
  an active panel. On reveal, re-assert DOM focus from the session's persisted
  focus state (the focus *class* survives — it's prop-driven; only DOM focus
  needs a nudge).

### Extension half — window-management shrinks

- A slot maps to a **deterministic session block id** (uuidv5 of
  device-session-id + slot, same pattern as `src/data/stateBlocks.ts`), both
  numbered (`'1'..'8'`) and item (`item:<blockId>`) slots.
- **Switch = one store write** (set active session id + repaint the bar),
  replacing the whole capture → `reconcilePanelRows` → repair-active-panel
  dance (`performSwitch`, `index.tsx:553`).
- The serialized-layout snapshot survives only as: (a) migration from the
  current localStorage format, (b) seed when a slot's session block doesn't
  exist yet, (c) the item-slot expiry sweep — which now must **also delete
  the expired session's block subtree** (sessions are UiState blocks that
  upload; leaked sessions are synced garbage).
- The bottom bar needs no changes — it's imperative DOM on `document.body`
  (`appEffectsFacet`), already outside the layout tree.

## Why `display:none`, not React `<Activity>`

React 19.2.6 (installed) exports stable `<Activity>` — the official
hide-with-state primitive — but `mode="hidden"` **runs effect cleanups**.
That's exactly wrong for the motivating case: the video player's
`registerVideoPlayer` handle (`src/plugins/video-player/VideoPlayerRenderer.tsx:101`)
unregisters in its effect cleanup, and any component tearing down resources on
cleanup degrades while hidden. Plain `display:none` keeps effects,
subscriptions, and playback fully live (a hidden `<video>` keeps playing
audio).

Cost: hidden trees still re-render on data changes — controlled by the LRU
cap rather than Activity's render deferral. `<Activity>` remains a later
optimization for warm-but-media-free sessions if hidden re-render cost shows
up in practice.

`LazyViewportMount` composes well: it never unmounts once mounted, and while
hidden its IntersectionObserver sees nothing — not-yet-seen blocks stay
unmounted until the perspective is revealed. Free partial hydration for warm
sessions.

## Alternatives considered

- **Portal-based content cache** — app-level host owns one
  `<BlockComponent>` per content block id and portals it into whichever panel
  shows it; no data-model change. Rejected: portals keep the *owner's* React
  context, so panel-scoped context (`panelId`, `renderScopeId`, ui-state
  resolution — gotcha #18) must be re-threaded per target, and physically
  moving a playing `<video>` between DOM containers pauses/hiccups playback
  in practice. Fights the framework everywhere the session-swap design goes
  with the grain.
- **One session, hide rows instead of deleting** — rows tagged
  per-perspective, `LayoutRenderer` filters. Pollutes the layout data model:
  URL projection, subtree queries, active-panel repair, and the layout
  watchdog all must learn to ignore hidden rows. More invasive than it looks.
- **Media-only persistence** — global media-element registry, or
  save-position-and-resume. Far less core change, but only fixes video, not
  the general "my perspective is exactly as I left it" property. Fallback if
  the core change stalls upstream.

## Open questions (resolve at implementation time)

- Where exactly keybind dispatch resolves "the active panel" — the
  hidden-session gating design hangs on it.
- `PanelLayoutProjection`: one instance rebound on switch vs. one per mounted
  session (hidden ones muted)?
- Mobile: `LayoutRenderer` already renders only the active panel there;
  keep-alive is likely desktop-only (warm cap = 1 on mobile).
- CodeMirror revealed from `display:none` may need a `requestMeasure` nudge.
- Warm-set eviction: is plain LRU enough, or should a session with actively
  playing media be pinned against eviction?
- History semantics across switches: what should Back do right after a
  perspective switch (return to prior perspective vs. prior layout within the
  current one)?

## Rollout sketch

1. Core: active-session store + `LayoutSessionHost` behind a default-off
   switch; single-session behavior unchanged.
2. Core: projection rebinding + input gating; verify with two hand-made
   sessions in the sandbox (video playing in one, switch away/back).
3. Extension: slot → deterministic session id, migration from localStorage
   snapshots, expiry sweep deletes session subtrees.
4. Sandbox-verify the full loop (`--profile test`, harness), then user gate,
   then promote + upstream PR via the km-upstream vehicle.

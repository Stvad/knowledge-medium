# Perspective keep-alive — sessions-per-perspective + a warm session host

> **Status:** proposed — design only, nothing built. Revised after upstream
> review (PR #357 thread: synced definitions, URL param, status-bar facet,
> Activity policy).
> Last verified against code: 2026-07-12 (src/ + agent-extensions/window-management/ @ working tree).

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
   the panel row id — the React `key` on the top-level slot list
   (`src/components/renderer/LayoutRenderer.tsx:193`, `slotsToRender.map`)
   and on `PanelSlotView`'s context provider (`LayoutRenderer.tsx:92`) —
   stays stable. `LayoutRenderer` mounts the row's
   `<BlockComponent blockId={slot.id}/>` (`LayoutRenderer.tsx:100`), which
   resolves to `PanelRenderer`; that reads `topLevelBlockIdProp`
   (`src/components/renderer/PanelRenderer.tsx:62`) and renders
   `<BlockComponent blockId={topLevelBlockId}/>` (`PanelRenderer.tsx:192`,
   no key). When the perspective switch rewrites `topLevelBlockIdProp`,
   that inner element reconciles to a different block and the whole content
   subtree unmounts.
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

### Data model — synced definitions, per-device live sessions

Two layers (upstream review outcome — all state in the DB, perspectives
available across devices):

- **Perspective definitions — synced.** A perspective registry of
  per-workspace UiState blocks: name, slot/order, kind (numbered vs
  per-item), target block for item perspectives. Defined once, available on
  every device. This replaces the extension's localStorage snapshot store
  entirely.
- **Live sessions — per-device.** Each device materializes its own
  layout-session block per perspective (`uuidv5(deviceBaseId +
  perspectiveId)`). Kept per-device deliberately: per-row view state
  (`scrollTopProp`, `focusedBlockLocationProp`, `activePanelIdProp`) lives on
  session/row blocks and syncs — two devices sharing one live session would
  ping-pong scroll and focus at each other. Sharing the *definition* but not
  the *live session* gives cross-device perspectives without that fight. A
  fully-shared live session ("my workspace follows me") is a possible later
  evolution, but requires first splitting per-device view state out of the
  shared layout structure — separable, bigger lift.

Note layout sessions already live in the database (UiState blocks under
`user page → ui-state → layout-sessions/<id>`); the only genuinely
device-local state left is two pointers — the stable base id and the active
perspective — and even the active pointer can move into a device-scoped DB
block if the all-state-in-DB principle is applied strictly.

### Core half — `LayoutSessionHost`

- **Two ids, kept distinct.** `getLayoutSessionId()`
  (`src/utils/layoutSessionId.ts:54`) today yields the one live per-device id
  (sessionStorage in a tab, localStorage installed). That id becomes the
  stable per-device **base id** — it never changes, and its storage key stays
  where it is. Alongside it, add a runtime-switchable **active session id**
  (module store à la `createToggleStore`, persisted per-device separately),
  defaulting to the base id — zero behavior change when nothing drives it.
  Per-perspective session ids are always derived from the *base* id
  (`uuidv5(baseId + ':' + perspectiveId)`), never from the currently active
  id — deriving from the active id would make session identity drift as you
  switch.
- **Perspective in the URL.** Perspective is workspace-scoped context, not
  slot-scoped, so it rides as a matrix param on the workspace segment of
  PR #338's URL grammar: `#ws;persp=work/a/b,c`. With synced definitions the
  link is portable across devices (the receiving device materializes its own
  live session for that definition), and history entries become
  perspective-qualified — which settles Back-across-a-switch semantics:
  Back returns to the prior perspective, because that's what the prior
  history entry encodes.
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
- **Input isolation** — the subtle correctness area, and it is wider than
  shortcut surfaces. Each session carries its own `activePanelIdProp`, so
  with N sessions mounted, N panels all believe they are active. Everything
  downstream of that belief must be gated on *session visibility*:
  - **Shortcut surfaces**: keybind dispatch and "active panel" resolution go
    through the active session only (e.g. a `sessionHidden` context flag
    checked by dispatch/activations).
  - **Action contexts**: `PanelRenderer` registers `MULTI_SELECT_MODE` for
    its active panel via `useActionContext`
    (`src/components/renderer/PanelRenderer.tsx:203`,
    `PanelMultiSelectActionContext`) — hidden sessions' active panels would
    each register it too. All `useActionContext` registrations under a
    hidden session must be suppressed (the same visibility flag, threaded
    through block context so it reaches every registration site).
  - **DOM selectors**: spatial navigation
    (`src/plugins/spatial-navigation/actions.ts:270`, `crossPanelFocus`) and
    window-management (`agent-extensions/window-management/index.tsx:236`,
    `panelElements`) locate the layout via
    `document.querySelector('[data-layout-session-id]')` — first match wins,
    which becomes ambiguous with several sessions mounted. The host must make
    the active session unambiguously addressable (e.g. only the visible
    wrapper carries a `data-layout-session-active` marker, plus `inert` on
    hidden wrappers as focus/click belt-and-braces), and a core helper
    (`activeLayoutSessionElement()`) replaces raw first-match queries at
    every call site.
  - On reveal, re-assert DOM focus from the session's persisted focus state
    (the focus *class* survives — it's prop-driven; only DOM focus needs a
    nudge).

### Extension half — window-management shrinks

- Slots become **registry entries** (synced perspective-definition blocks,
  see the data model above), both numbered (`'1'..'8'`) and item
  (`item:<blockId>`). Each maps on a given device to a **deterministic
  session block id** (uuidv5 of base id + perspective id, same pattern as
  `src/data/stateBlocks.ts`).
- **Switch = one store write** (set active session id + repaint the bar),
  replacing the whole capture → `reconcilePanelRows` → repair-active-panel
  dance (`performSwitch`, `index.tsx:553`).
- The serialized-layout snapshot survives only as: (a) migration from the
  current localStorage format into the registry, (b) seed when a
  perspective's session block doesn't exist yet on this device, (c) the
  item-slot expiry sweep — which now must **also delete the expired
  perspective's session block subtrees** (sessions are UiState blocks that
  upload; leaked sessions are synced garbage).
- The bottom bar moves from imperative `document.body` DOM to an
  **`appMountsFacet` contribution** (`src/extensions/core.ts:218` — React,
  app scope, outside the layout tree, survives switches; the imperative DOM
  was expedience, not necessity). If multiple extensions ever compose
  indicators, a `statusBarItemsFacet` mirroring `headerItemsFacet`'s region
  pattern is the natural core addition (upstream review outcome; a
  LayoutRenderer override is heavier than the bar needs).

## Hiding policy: `display:none` by default, `<Activity>` as per-session optimization

React 19.2.6 (installed) exports stable `<Activity>` — the official
hide-with-state primitive. What it buys over a hand-rolled `display:none`
wrapper: hidden subtrees' re-renders are deferred to background priority
(they never block the visible perspective), state and DOM are preserved with
official semantics, and it's where React is investing (`mode="hidden"`
pre-rendering could later give "warm up a perspective before first visit").

The crux is effect semantics: **hiding runs effect cleanups, revealing
re-runs them.** Concretely in KM: the video player's `registerVideoPlayer`
handle (`src/plugins/video-player/VideoPlayerRenderer.tsx:101`) unregisters
in its effect cleanup, and react-player tears down its underlying player
instance in cleanup (YouTube iframes especially) — playback stops, defeating
the headline feature. CodeMirror editors are created in effects, so hide
destroys them and reveal pays re-init plus loses editor-local transient
state. Plain `display:none` keeps effects, subscriptions, and playback fully
live (a hidden `<video>` keeps playing audio).

So: Activity is the right tool for "cheap warm resume", the wrong one for
"keep running". Policy (upstream review outcome): `display:none` wrappers by
default; `<Activity>` as a per-session optimization for warm sessions with
no live media. Both fit the same host — a per-slot policy, not an
architecture fork.

Background cost model: per warm session, retained DOM (bounded — see
`LazyViewportMount` below) plus live query subscriptions that re-render the
hidden tree on writes. A quiet workspace costs ≈ zero (handle-level
structural-diff dedup); the real cost is write bursts (sync storms)
re-rendering N hidden trees. Controls, in order: the small LRU cap (2–3;
eviction fully unmounts and releases everything), item-perspective expiry
deleting dead sessions, and Activity for media-free warm sessions.

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
- Definition ↔ session reconciliation: when a synced perspective definition
  changes while a device holds a diverged live session for it, what wins on
  next switch (reconcile rows to the definition vs. keep the local session
  and offer a reset)? Related: should local layout edits write back to the
  definition, and when?

## Rollout sketch

1. Core: active-session store + `LayoutSessionHost` behind a default-off
   switch; single-session behavior unchanged.
2. Core: projection rebinding + input gating; verify with two hand-made
   sessions in the sandbox (video playing in one, switch away/back).
3. Extension: synced perspective registry + per-device deterministic session
   ids, migration from localStorage snapshots into the registry, expiry sweep
   deletes session subtrees, bar → `appMountsFacet`.
4. Sandbox-verify the full loop (`--profile test`, harness), then user gate,
   then promote + upstream PR via the km-upstream vehicle.

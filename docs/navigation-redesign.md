# Navigation redesign — step 4 plan + accumulated decisions

Captures the design discussion from the navigation refactor up through step 3 (state preservation). This document is the working spec for step 4 and the post-step-4 extensibility roadmap. Written 2026-05-08.

## Where we are now (committed up through 078e426)

- **Step 1 (cf397f0)**: `navigate()` primitive — single entry point for "go to a block" / "open in new panel". Replaces scattered `writeAppHash` + `dispatchEvent('open-panel')` call sites.
- **Step 2 (62c0c79, df31fef, 801ad78, aafef3f, 5df09b3)**: per-panel back/forward stacks (in-memory `panelHistory`), back/forward chevrons in panel chrome, in-panel link clicks route through `navigate({target:'focused', panelId})` so plain clicks inside a side panel stay in that panel. `useBlockLinkClick` hook + pure `handleBlockLinkClick` factor out modifier-key policy.
- **Step 3 (078e426)**: per-visit state preservation — each history entry carries a `VisitState` snapshot (focused block + scroll), captured before navigation via a snapshotter the PanelRenderer registers. Restored on back/forward.

## Step 4 goal

Open-panels list moves from the workspace UI-state DB into the URL. Driving change: panel layout is per-tab view state, not workspace content — opening a workspace on a different device shouldn't inherit this device's panels.

## Decisions resolved

### URL shape (no back-compat constraint — old shape can break)

```
#<wsId>/<blockId1>(/<blockId2>(/<blockId3>...))*
```

Flat ordered list, leftmost = focused/main panel, no special focused-vs-panels suffix. Empty list (`#<wsId>`) = no panels rendered (workspace landing). Compact, shareable, human-readable.

Sticking with hash (vs query string / pathname): hash works on any static host with no SPA-fallback config, and block ids never leak into HTTP request lines, server logs, or `Referer` headers. No SEO/SSR target makes the usual reasons to prefer pathname routing moot. Query params remain available for orthogonal config (`?debug=1#wsId/b1/b2`).

#### Beyond a flat list

The flat-list URL is a degenerate case of the durable data model — a **slot tree**:

```ts
type Slot =
  | {kind: 'leaf';   block: BlockId}
  | {kind: 'tabs';   children: Slot[]; active: number}
  | {kind: 'split';  orient: 'h'|'v'; ratios: number[]; children: Slot[]}
```

(Same shape IDEs / Emacs use for window layout.) Step 4 implements the linear-tabs case; the model can grow into splits/named tabs without re-architecting.

Transport options when we need richer layouts:

- **URL = flat list** (current step-4 plan): structure is implicit, all slots are leaves in one tabs container. Cheap, shareable.
- **URL = layout-id** (`#wsId/L7`): URL carries an opaque pointer; the tree lives in IndexedDB / a saved-layouts table. Clean URL, not shareable across devices unless we also sync the layout def.
- **URL = inlined tree** (`#wsId/share=<base64>`): expand on demand for "share this layout" — heavy, but bounded and self-contained.

Decision punt: pick whichever transport when the first non-linear layout actually lands. Right now the data model is a tabs-of-leaves and the URL is a flat list, no need to commit further.

### Slot identity

**Stable in-memory UUIDs assigned at slot creation, never in the URL.** URL is just the positional block list.

On URL change (browser back/forward, external setHash): reconcile current in-memory slots against new URL via **longest-common-subsequence diff**. Slots that survive in the new URL keep their UUID + history; new blocks become new slots; missing blocks get their slot data dropped.

Why: positional indexing breaks insert-in-middle (history shifts to wrong panel); blockId-derived breaks "same panel, different blocks over time"; embedding UUIDs in URL is noisy. LCS reconciliation gives the right behavior for all of: append, close, intra-panel nav, insert-in-middle.

Trade-off accepted: page reload loses slot identity (URL has only blocks, not slot UUIDs), so all per-slot history + ephemeral state resets. Same trade-off browsers make for tabs — URL survives reload, scroll/cursor don't.

### Browser history strategy

- **Push** on open-panel and close-panel — browser back closes the most-recently-opened panel.
- **replaceState** on intra-panel navigation — within-panel hops don't pollute browser back-stack; the per-panel back chevron handles those via the in-memory stack.

This gives clean separation: browser back operates over panel layout; per-panel back operates over within-panel block history.

### State preservation across navigation (already shipped in step 3, will migrate)

`VisitState` snapshot per history entry: focused block, scroll position, room to grow (selection, editor state). In-memory only. Captured by a snapshotter the PanelRenderer registers; restored on back/forward.

Reload survival not implemented; could be bolted on later via sessionStorage keyed by URL block list.

### Workspace switch

URL becomes `#<new-wsId>` — just the workspace id, empty block list. A block from workspace A makes no sense in workspace B, so we don't try to carry the panel list across.

### Mobile

Render only the last (focused) slot. Close button = browser back, which pops the URL → previous slot becomes current. Same data model as desktop, single-slot viewport. Tiny change once slot infra is in place.

### Legacy panel-block rows in existing user DBs

Ignore (this is alpha). Optional one-shot cleanup migration if cruft becomes an issue later.

### Cmd+[/], forward/back mouse buttons

Currently use `window.history.back()` / `forward()` which operates on browser history (mostly tracking main-panel URL changes). Punt fix to step 4: browser history will only push on panel-layout changes, so cmd-[/] naturally becomes "close the most-recently-opened panel" or similar — and per-panel keys (some other binding) will operate on the focused slot's in-memory stack.

## Step 4 execution plan

### 4a. Foundation, no behavior change

- Extend `routing.ts` with parser/builder for the new path-list format. `parseLayout(hash) → {workspaceId, blockIds: string[]}`, `buildLayout(workspaceId, blockIds) → hash`.
- New `panelLayoutStore.ts`: in-memory `{slots: Map<slotId, {blockId, history, ephemeralState}>, slotOrder: slotId[]}` + LCS reconciliation function `reconcile(current, urlBlockIds) → {slotOrder, slots}`.
- Subscribe to `hashchange`; reconcile and update store.
- Run in parallel with existing DB-driven LayoutRenderer — store is just observing, no UI uses it yet.
- Tests: URL parse/build round-trips; LCS reconciliation across append, close, intra-panel update, insert-in-middle, full replace.

### 4b. Migrate ephemeral state to slot store

Big diff. Currently lives on panel block as DB properties:
- `focusedBlockIdProp`
- `selectionStateProp` (multi-select)
- `editorSelection`
- `requestEditorFocus`
- (others — full inventory needed before starting)

Move each to slot-keyed in-memory state. ~15–25 call sites read these via `block.peekProperty(...)` / `block.set(...)`. Update each to read/write through the slot store via a hook (`useSlotEphemeral(slotId, key)` or property-shaped facade).

Decision deferred to implementation: direct call-site rewrite vs. Block-shaped facade. Lean toward direct — facade hides the architectural shift and risks subtle bugs at the seam.

Tests: keep DB-driven layout still rendering, prove store feeds the same data.

### 4c. Cut over rendering

- `LayoutRenderer`: reads slot list from store/URL instead of `panelBlock.children`. No more `ensureMainPanel`, no more `'open-panel'` event listener.
- `PanelRenderer`: takes `{slotId, blockId}` props instead of a `panelBlock`. Continues to register snapshotter (now keyed by slotId).
- `navigate({target: 'new-panel', sourcePanelId})`: looks up source slot's index, inserts new block at `index + 1` in URL, pushes browser history.
- Close button: removes slot's block from URL, pushes browser history.
- Intra-panel nav: replaceState (no history pollution).
- Mobile: render `slots.at(-1)` (or focused slot specifically); close = `history.back()`.
- Workspace switch: write `#<wsId>` to URL, push.
- Cmd-[/], forward/back mouse: rebind to "navigate focused slot" via the in-memory stack.

### 4d. Cleanup

- Delete `ensureMainPanel`, panels block infrastructure, panel-block creation paths.
- Delete `'open-panel'` CustomEvent.
- Drop `ChangeScope.UiState` panel writes (panels aren't DB-driven anymore).
- Optional: one-shot migration to clean up existing panel rows.

## Post-step-4: emacs-grade extensibility (separate work)

In priority order (none of these block step 4):

1. **`navigationFacet`** — turn `navigate(input)` into `runtime.read(navigationFacet)({...})`. Default contribution = current behavior. Plugin contributions can short-circuit (custom block-type viewers) or replace wholesale. Same `combineLastContributionResult` pattern as variants.
2. **`urlSerializerFacet`** — `parse(hash) → AppState`, `build(state) → hash`. Pluggable URL format.
3. **`panelHistoryFacet`** — alternative history models (tree-shaped, named bookmarks, time-travel debugger).

The current navigation code grew before facet was the dominant idiom; once step 4 stabilizes the data flow, these retrofits are mostly mechanical (factor out, expose via runtime).

## Constraints / non-goals

- No back-compat for the old `#wsId/blockId?panels=...` shape we never shipped. Old `#wsId/blockId` is a special case of the new shape, so it parses fine.
- Reload-survival of slot identity / per-visit state: not in step 4. Bolt on via sessionStorage if/when needed.
- Persistent named layouts: not in step 4. A future feature; URL would carry `?layout=id` and the structure would live in DB.
- Cross-device sync of any panel layout: explicitly NOT a goal — that's the whole reason for the move out of DB.

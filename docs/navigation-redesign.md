# Navigation redesign — step 4 plan + accumulated decisions

Captures the design discussion from the navigation refactor up through step 3 (state preservation). This document is the working spec for step 4 and the post-step-4 extensibility roadmap. Written 2026-05-08.

## Where we are now (committed up through 078e426)

- **Step 1 (cf397f0)**: `navigate()` primitive — single entry point for "go to a block" / "open in new panel". Replaces scattered `writeAppHash` + `dispatchEvent('open-panel')` call sites.
- **Step 2 (62c0c79, df31fef, 801ad78, aafef3f, 5df09b3)**: per-panel back/forward stacks (in-memory `panelHistory`), back/forward chevrons in panel chrome, in-panel link clicks route through `navigate({target:'focused', panelId})` so plain clicks inside a side panel stay in that panel. `useBlockLinkClick` hook + pure `handleBlockLinkClick` factor out modifier-key policy.
- **Step 3 (078e426)**: per-visit state preservation — each history entry carries a `VisitState` snapshot (focused block + scroll), captured before navigation via a snapshotter the PanelRenderer registers. Restored on back/forward.

## Step 4 goal

Make the URL a first-class projection of panel layout: open/close/reorder operations show up in the URL, browser back operates over panel layout, links share their layout. **Substrate stays in the workspace DB** — panel rows already use `ChangeScope.UiState` (not synced, not undoable). The URL is a bidirectional projection of those rows, not a replacement substrate.

This honors Riffle's prelude (one reactive store; scope-as-metadata) while still getting URL-as-address-bar for the things that genuinely need it (browser interop, sharing, deep-linking).

## Decisions resolved

### Substrate: workspace DB rows, UiState scope

Panel rows stay in the workspace DB. UiState scope already gives "don't sync across devices, don't enter undo stack." Components keep using existing reactive hooks (`usePropertyValue`, `useChildren`, etc.) — no parallel store.

The only deviation we considered (a fresh in-memory `panelLayoutStore`) was redundant with what UiState scope already provides, and would have fragmented the substrate for no win.

### Per-tab scoping via `tabId`

Without tab scoping, two browser tabs on the same workspace would share panel rows (and clobber each other's URL state). Add a `tabId` property on panel rows:

- `tabId` lives in `sessionStorage` (per-tab natively, persists across reload of the same tab, dies on tab close).
- On first load: read `sessionStorage['ws-nav.tabId']`; if missing, generate a UUID and store it.
- Layout query filters panel rows to `(workspaceId, tabId)`. Each tab renders its own slice.
- Reconciliation writes are scoped to current `tabId`.

GC of orphan rows (tab closed → its rows linger): punt for alpha. Can add a localStorage-heartbeat-based sweep later. Worst case: rows accumulate; they're tiny and UiState-scoped, so no sync impact.

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
  | {kind: 'leaf';   block: BlockId}                                       // terminal content node — a block in a position
  | {kind: 'tabs';   children: Slot[]; active: number}                     // arrangement: pick one of N
  | {kind: 'split';  orient: 'h'|'v'; ratios: number[]; children: Slot[]}  // arrangement: lay out N side-by-side
```

Same shape IDEs / Emacs use for window layout. `tabs` and `split` are arrangement containers; `leaf` is the actual rendered block (the recursion has to bottom out somewhere). Step 4 implements the all-leaves-in-one-tabs case; the model can grow into splits / nested tabs / etc. without re-architecting.

**URL transport: inline grammar, current flat list is a strict subset.** Block ids are alnum+`-_`, so `,` `|` `:` `(` `)` are free as structural chars:

| What | Syntax | Example |
|---|---|---|
| leaf | bare id | `b1` |
| tabs | comma in parens | `(b1,b2,b3)` — active = first; `(b1,b2,b3:1)` to pin active |
| h-split | `h:` prefix | `(h:b1,b2)` |
| v-split | `v:` prefix | `(v:b1,b2)` |
| top level | `/`-separated slots (implicit outer tabs container) | `b1/b2/b3` |

Examples across complexity:

```
current Roam sidebar   #wsId/b1/b2/b3
tabs in second slot    #wsId/b1/(b2,b3)/b4
horizontal split       #wsId/(h:b1,b2)
nested                 #wsId/b1/(h:(v:b2,b3),b4)
```

Step 4 only ships the bare-id + `/`-separated case. Adding `()` groups later is a parser extension, not a breaking change — every URL that worked before keeps working. Layout-id (`#wsId/L7` pointing at a stored layout) stays available as an opt-in for *named* saved layouts; not the default transport.

### Slot identity = panel rowId

Panel rows are the source of truth; their rowId is the slot identity. Survives reload (DB persists), survives intra-panel navigation, naturally extends to splits/tabs (those would just be additional row types).

URL ↔ DB reconciliation on hashchange: LCS diff matches URL block list to existing panel rows for `(workspaceId, tabId)`, preserving per-row state where blocks survive. Insert-in-middle, append, close, intra-panel nav all work; the LCS does the same job it did in the in-memory-store version, just over DB rows.

### Browser history strategy

- **Push** on open-panel and close-panel — browser back closes the most-recently-opened panel.
- **replaceState** on intra-panel navigation — within-panel hops don't pollute browser back-stack; the per-panel back chevron handles those via the in-memory stack.

This gives clean separation: browser back operates over panel layout; per-panel back operates over within-panel block history.

### Visit state (focused block, scroll) — persist via UiState properties

Already partially shipped in step 3 as in-memory snapshots on panel-history entries. Promote to DB-backed:

- `focusedBlockIdProp` — already a UiState property on panel rows. Keep.
- `scrollTopProp` — new. UiState property on panel rows. Written debounced on scroll (after scroll-stop, ~200ms) and on `visibilitychange`. Read on mount, applied to scroll ref after layout.

Reload-survival of focus + scroll is now free, since DB rows persist and `tabId` scopes them per-tab.

### Per-panel back/forward block history — keep in-memory

`panelHistory` (back/forward stacks of `{blockId, VisitState}` per panel) stays in-memory for now. Matches browser tab back-stack semantics: dies with the session. Promoting it to DB rows is doable later (UiState scope, written on every nav) but adds row churn for a feature that's session-scoped in user expectation.

The snapshotter pattern remains as the bridge between PanelRenderer and the in-memory stack; the data it captures (focused, scroll) is the same data we now persist as UiState properties.

### Workspace switch

URL becomes `#<new-wsId>` — just the workspace id, empty block list. The projection clears panel rows for the current `tabId` and the new workspace renders blank. Other tabs' panel rows are unaffected.

### Mobile

Render only the last (focused) panel for the current tab. Close button = browser back, which pops the URL → previous block becomes current. Pure renderer change; data model unchanged.

### Legacy panel-block rows in existing user DBs

Ignore (alpha). Rows from before the `tabId` migration won't have the property and will be invisible to the filtered query — effectively orphaned. Optional one-shot cleanup if cruft becomes an issue.

### Cmd+[/], forward/back mouse buttons

Currently use `window.history.back()` / `forward()` against browser history (which mostly tracks main-panel URL changes today). After step 4, browser history pushes on panel-layout changes only, so these natively become "close most recently opened panel / reopen it" — the user-facing meaning matches the keys' name.

Per-panel back/forward stays bound to the chevrons in panel chrome.

## Step 4 execution plan

### 4a. URL parser/builder + tabId infrastructure

- Extend `routing.ts`: `parseLayout(hash) → {workspaceId, blockIds: string[]}`, `buildLayout(workspaceId, blockIds) → hash`. Bare-id + `/`-separated only; structure to allow extending to `()` groups without breaking the API.
- New `tabId.ts`: `getTabId()` reads/generates UUID in `sessionStorage['ws-nav.tabId']`, memoized.
- Add `tabId` UiState property to panel block schema.
- Tests: parser round-trips (including empty-list, single-block, multi-block); tabId persistence across the same module's lifetime; tabId differs across simulated tabs.

No behavior change yet — the parser/tabId infrastructure exists but nothing reads the URL or writes the tabId.

### 4b. URL ↔ panel-row projection

- New `panelLayoutProjection.ts` (or fold into `routing.ts`):
  - On `hashchange`: parse → LCS reconcile against panel rows for `(currentWorkspaceId, currentTabId)` → write rows in a single UiState tx (insert/delete to match URL block list, preserve existing rows on identity match).
  - On panel-row mutation in current tab: build URL, write hash via `pushState` (open/close) or `replaceState` (intra-panel nav).
  - Loop guard: tag programmatic URL writes so the resulting `hashchange` is a no-op for that pass.
- Existing `LayoutRenderer` keeps reading `panelBlock.children`, but now those children are kept in sync with URL.
- Tests: open-panel writes URL; close-panel writes URL; browser back replays panel rows; reload restores layout; reorder preserves rowId; two simulated tabIds don't see each other.

### 4c. Wire `navigate()` and close through the projection

- `navigate({target: 'new-panel', sourcePanelId})`: insert a new panel row at `sourceIndex + 1` (UiState scope). Drop `dispatchEvent('open-panel')` from `navigation.ts`; drop `'open-panel'` CustomEvent listener from `LayoutRenderer`.
- `handleClose` in `PanelRenderer`: stays as-is (already a UiState delete) — projection picks up the row deletion and updates URL.
- Workspace switch: existing path writes `#<new-wsId>` to URL; projection clears panel rows.
- Cmd-[/], forward/back mouse: keep bound to `history.back/forward()` — gets the right semantics for free now that browser history tracks panel layout.

### 4d. Visit state persistence (scroll)

- Add `scrollTopProp` (UiState, number-or-null) to panel block schema.
- `PanelRenderer`:
  - On scroll: debounced write of `scrollRef.current.scrollTop` to row.
  - On `visibilitychange` to hidden: flush pending write.
  - On mount + `topLevelBlockId` change: read `scrollTopProp` from row and apply to scrollRef in a post-layout effect (same pattern as the existing `consumeRestore`).
- Existing in-memory snapshotter / restore queue stays — it's still the right substrate for *intra-session* per-panel back/forward, where we don't want every nav writing to DB.
- Tests: scroll persists across reload; doesn't sync across devices (UiState); doesn't pollute the other tab's row.

### 4e. Cleanup

- Delete `'open-panel'` CustomEvent (event name + dispatcher + listener).
- Audit `ensureMainPanel`: keep as the projection's "ensure rows match URL on workspace switch" helper (renamed if its scope shifts).
- Confirm no panel-row writes use a non-UiState scope outside the projection.

## Post-step-4: emacs-grade extensibility (separate work)

In priority order (none of these block step 4):

1. **`navigationFacet`** — turn `navigate(input)` into `runtime.read(navigationFacet)({...})`. Default contribution = current behavior. Plugin contributions can short-circuit (custom block-type viewers) or replace wholesale. Same `combineLastContributionResult` pattern as variants.
2. **`urlSerializerFacet`** — `parse(hash) → AppState`, `build(state) → hash`. Pluggable URL format.
3. **`panelHistoryFacet`** — alternative history models (tree-shaped, named bookmarks, time-travel debugger).

The current navigation code grew before facet was the dominant idiom; once step 4 stabilizes the data flow, these retrofits are mostly mechanical (factor out, expose via runtime).

## Constraints / non-goals

- No back-compat for the old `#wsId/blockId?panels=...` shape we never shipped. Old `#wsId/blockId` is a special case of the new shape, so it parses fine.
- Per-panel back/forward block history surviving reload: not in step 4. Punt to a follow-up — promoting `panelHistory` stacks to UiState rows is straightforward but adds row churn we don't need yet.
- Persistent named layouts: not in step 4. A future feature; URL would carry an opaque layout id (`#wsId/L7`) and the structure would live in a saved-layouts store. Coexists with the inline grammar — opt-in only when the user explicitly names a layout.
- Cross-device sync of any panel layout: explicitly NOT a goal. UiState scope keeps panel rows out of PowerSync.
- GC of orphan panel rows from closed tabs: not in step 4. Add a heartbeat-based sweep if/when this becomes a real issue.

## Relation to Riffle's prelude

The previous draft of this plan introduced a parallel in-memory `panelLayoutStore`. That deviated from Riffle's substrate-uniformity principle for no real gain — `ChangeScope.UiState` already provides the "ephemeral, not synced, not undoable" scope Riffle's essay describes as the right way to handle this kind of state. The current plan stays inside the existing reactive substrate; URL and `sessionStorage` are projections, not separate state authorities.

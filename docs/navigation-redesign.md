# Navigation redesign — step 4 plan + accumulated decisions

Captures the design discussion from the navigation refactor up through step 3 (state preservation). This document is the working spec for step 4 and the post-step-4 extensibility roadmap. Written 2026-05-08.

> **Correction (2026-06-15):** an earlier draft assumed `ChangeScope.UiState` writes stay device-local and out of PowerSync. They don't — UiState writes upload and sync through the normal queue like any other scope; the scope only opts out of the undo stack, not out of sync. Syncing UI state through ordinary block rows is a deliberate, affirmed decision: device-local ephemeral state was removed on purpose in favor of one uniform storage substrate, so focus/scroll/layout restore across devices. The inline notes below have been corrected to say "not undoable" rather than "not synced."

## Where we are now (committed up through 078e426)

- **Step 1 (cf397f0)**: `navigate()` primitive — single entry point for "go to a block" / "open in new panel". Replaces scattered `writeAppHash` + `dispatchEvent('open-panel')` call sites.
- **Step 2 (62c0c79, df31fef, 801ad78, aafef3f, 5df09b3)**: per-panel back/forward stacks (in-memory `panelHistory`), back/forward chevrons in panel chrome, in-panel link clicks route through `navigate({target:'focused', panelId})` so plain clicks inside a side panel stay in that panel. `useBlockLinkClick` hook + pure `handleBlockLinkClick` factor out modifier-key policy.
- **Step 3 (078e426)**: per-visit state preservation — each history entry carries a `VisitState` snapshot (focused block + scroll), captured before navigation via a snapshotter the PanelRenderer registers. Restored on back/forward.

## Step 4 goal

Make the URL a first-class projection of panel layout: open/close/reorder operations show up in the URL, browser back operates over panel layout, links share their layout. **Substrate stays in the workspace DB** — panel rows already use `ChangeScope.UiState` (synced, but not undoable). The URL is a bidirectional projection of those rows, not a replacement substrate.

This honors Riffle's prelude (one reactive store; scope-as-metadata) while still getting URL-as-address-bar for the things that genuinely need it (browser interop, sharing, deep-linking).

## Decisions resolved

### Substrate: workspace DB rows, UiState scope

Panel rows stay in the workspace DB. UiState scope already gives "don't enter undo stack" (it still syncs, like any scope). Components keep using existing reactive hooks (`usePropertyValue`, `useChildren`, etc.) — no parallel store.

The only deviation we considered (a fresh in-memory `panelLayoutStore`) was redundant with what UiState scope already provides, and would have fragmented the substrate for no win.

### Layout-session scoping via layout-session parent block

Without session scoping, two browser tabs on the same workspace would share panel rows (and clobber each other's URL state). Each browser tab gets its own parent block under the existing UI-state tree, while an installed PWA reuses one stable parent across close/reopen:

```
workspace
  userBlock(userId)
    ui-state
      layout-sessions
        {layoutSessionIdA}
          panel-row-1
          panel-row-2
        {layoutSessionIdB}
          panel-row-3
```

Built from the existing `ensureUiChild` pattern in `globalState.ts` — `ensureUiChild(uiState, 'layout-sessions')` then `ensureUiChild(layoutSessionsBlock, layoutSessionId)` gives the layout-session parent block. Panel rows live as children of the layout-session block (no intermediate `panels` container needed).

- **Browser tabs:** `layoutSessionId` lives in `sessionStorage['ws-nav.layoutSessionId']`, so it persists across reload of the same tab and dies on tab close.
- **Installed PWA / standalone display:** `layoutSessionId` lives in `localStorage['ws-nav.installedAppLayoutSessionId']`, so close/reopen restores the same layout-session block.
- On first load for either storage mode: read the current mode's key; if missing, generate a UUID and store it. There is no browser-exposed per-installation id, so this is an app-owned client identity.
- **Caveat (accepted for alpha):** "duplicate tab" / "open in new tab" flows can clone the initial `sessionStorage`, so the new tab starts with the same `layoutSessionId` and ends up sharing the layout-session block with its opener. We accept this — the failure mode is the same as having one extra browser tab effectively, and the workaround (lease/heartbeat to rotate `layoutSessionId` when another live tab claims it) is more machinery than the cost warrants right now. Note as a known limitation; revisit if it becomes a real issue.
- Layout reads use `useChildren(layoutSessionBlock)` directly — no filter. Order-key sorting is per-parent, so each layout session's panel order is independent.
- Reconciliation writes target the layout-session block's children.

Considered alternative — shared `panels` parent + `layoutSessionId` property on each row — but it loses on both read path (filter step on every render) and GC (per-row scan + delete instead of subtree delete). Layout-session parent matches the existing `ensureUiChild` idiom; not new structure.

GC of orphan layout-session subtrees: punt for alpha, but the cleanup story is one delete per stale layout session (cascade from the layout-session block) once we want it. Heartbeat in `localStorage` (or a `lastSeenAt` UiState property on the layout-session block itself) tells us which layoutSessionIds are stale. Cheaper than the per-row sweep the shared-parent approach would have needed.

### URL shape (no back-compat constraint — old shape can break)

```
#<wsId>/<blockId1>(/<blockId2>(/<blockId3>...))*
```

Flat ordered list, leftmost = focused/main panel, no special focused-vs-panels suffix. Empty list (`#<wsId>`) is a transient state — the projection restores prior `(layoutSessionId, wsId)` rows if any exist, else the landing layer fills in today's daily note (see "Workspace switch + default landing" below). Compact, shareable, human-readable.

Sticking with hash (vs query string / pathname): hash works on any static host with no SPA-fallback config, and block ids never leak into HTTP request lines, server logs, or `Referer` headers. No SEO/SSR target makes the usual reasons to prefer pathname routing moot. Query params remain available for orthogonal config (`?debug=1#wsId/b1/b2`).

#### Beyond a flat list

The flat-list URL is a degenerate case of the durable data model — a **slot tree**:

```ts
type Slot =
  | {kind: 'leaf';   block: BlockId}                                       // terminal content node — a block in a position
  | {kind: 'stack';  children: Slot[]}                                     // Roam-sidebar-style vertical stack
  | {kind: 'tabs';   children: Slot[]; active: number}                     // arrangement: pick one of N
  | {kind: 'split';  orient: 'h'|'v'; ratios: number[]; children: Slot[]}  // arrangement: lay out N side-by-side
```

Same shape IDEs / Emacs use for window layout. `stack`, `tabs`, and `split` are arrangement containers; `leaf` is the actual rendered block (the recursion has to bottom out somewhere). Step 4 implements the all-leaves-in-one-tabs case; the model can grow into splits / nested tabs / etc. without re-architecting. The Roam-sidebar mode is the first extension: a `stack` container is a vertical list of full-height panel leaves inside one horizontal column.

**URL transport: inline grammar, current flat list is a strict subset.** Block ids are alnum+`-_`, so `,` `|` `:` `(` `)` are free as structural chars:

| What | Syntax | Example |
|---|---|---|
| leaf | bare id | `b1` |
| stack | `s:` prefix | `(s:b1,b2)` |
| tabs | comma in parens | `(b1,b2,b3)` — active = first; `(b1,b2,b3:1)` to pin active |
| h-split | `h:` prefix | `(h:b1,b2)` |
| v-split | `v:` prefix | `(v:b1,b2)` |
| top level | `/`-separated slots (implicit outer tabs container) | `b1/b2/b3` |

Examples across complexity:

```
current panel stack    #wsId/b1/b2/b3
sidebar stack          #wsId/b1/(s:b2,b3)/b4
tabs in second slot    #wsId/b1/(b2,b3)/b4
horizontal split       #wsId/(h:b1,b2)
nested                 #wsId/b1/(h:(v:b2,b3),b4)
```

Step 4 initially shipped the bare-id + `/`-separated case; Roam-sidebar mode adds `(s:...)` groups while preserving every flat URL that already worked. Layout-id (`#wsId/L7` pointing at a stored layout) stays available as an opt-in for *named* saved layouts; not the default transport.

### Slot identity = panel rowId

Panel rows are the source of truth; their rowId is the slot identity. Survives reload (DB persists), survives intra-panel navigation, naturally extends to splits/tabs (those would just be additional row types).

URL ↔ DB reconciliation on hashchange: for a non-empty block list, LCS diff matches URL block list to existing panel rows for `(workspaceId, layoutSessionId)`, preserving per-row state where blocks survive. Insert-in-middle, append, close, intra-panel nav all work; the LCS does the same job it did in the in-memory-store version, just over DB rows. Empty block list (`#<wsId>`) is the special case handled by the workspace-landing path below — it means "restore prior layout for `(layoutSessionId, wsId)` if any, else fill in daily note," not "reconcile to zero rows."

### Browser history strategy

**Push on every navigation that changes the URL.** Open-panel, close-panel, reorder, intra-panel nav (link clicks inside a panel), per-panel back/forward chevron clicks. Browser back is the universal undo: it undoes whatever the most recent navigation was, regardless of level.

Earlier drafts of this doc kept replaceState for intra-panel nav as a "clean separation of concerns" (browser back = panel-level, chevrons = block-level). In practice users expect browser back to undo their last navigation, period — including link clicks inside a panel. The clean-separation framing fights that expectation, and the data-shape classifier doesn't have to enforce it.

`replaceState` is still used in one narrow case: **bootstrap-landing fillin** (see "Workspace switch + default landing"). The landing layer writes URL via `replaceState` *before* writing the row, so the observer's idempotency rule kicks in and no extra history entry is added. This is the one path that wants the URL to change without a back-button affordance.

**Per-panel back chevrons** stay useful as a panel-scoped undo. They push too — clicking the back chevron in panel 1 pushes a new history entry where panel 1 is at its previous block. Symmetric with link clicks. Means browser back can undo a chevron click (one slight conceptual oddity, but predictable). Alternative we considered and rejected: chevrons walking `history.go(-1)` until they find an entry where this panel's block differs — requires `history.state` per-panel snapshots to be inspectable; punt as a follow-up if option-as-shipped is annoying.

#### Event mechanics (the part that bites)

Browser hash/history APIs each fire a different subset of events. Spelling it out so the projection handles all three cases:

| Action | Fires `hashchange`? | Fires `popstate`? | History? |
|---|---|---|---|
| `location.hash = X` | yes | no | always pushes |
| `history.pushState(_, _, '#X')` | no | no | pushes |
| `history.replaceState(_, _, '#X')` | no | no | replaces current entry |
| User clicks back/forward (same doc) | yes if hash changed | yes | navigates |

Implications:

- The only replace-state case in step 4 is bootstrap-landing fillin, which uses `history.replaceState` directly. Outbound observer writes (every other URL change) all push, so `location.hash =` would also work for those — using `pushState` is just to avoid scattering URL-write mechanisms.
- `pushState` / `replaceState` notify *no one*. The projection has to call its own subscribers after writing.
- For external URL changes (back/forward, user typing in URL bar, other tabs writing the hash via `BroadcastChannel`-like mechanisms), we need to listen to **both** `hashchange` and `popstate` — `hashchange` alone misses pushState-based history entries when both endpoints have the same hash (rare for us but possible), and `popstate` alone misses external `location.hash` writes.
- Existing `useHash` (`hashchange` only) is enough for today's `writeAppHash` (which uses `location.hash =`). After step 4, components stop subscribing to `hashchange` directly and instead subscribe to the projection — which internally listens to both events and emits a single normalized change.

### Visit state (focused block, scroll) — persist via UiState properties

Already partially shipped in step 3 as in-memory snapshots on panel-history entries. Promote to DB-backed:

- `focusedBlockLocationProp` — UiState property on panel rows. It superseded the older unscoped `focusedBlockId` key.
- `scrollTopProp` — new. UiState property on panel rows. Written debounced on scroll (after scroll-stop, ~200ms) and on `visibilitychange`. Read on mount, applied to scroll ref after layout.

Reload-survival of focus + scroll is now free, since DB rows persist and `layoutSessionId` scopes them to the layout session.

### Per-panel back/forward block history — keep in-memory, reconcile on popstate

`panelHistory` (back/forward stacks of `{blockId, VisitState}` per panel) stays in-memory. Matches browser tab back-stack semantics: dies with the session.

Interaction with browser history (now that intra-panel nav pushes too):

- Click chevron back in panel 1: pop from panel 1's local back stack, push to its forward stack. Updates `topLevelBlockIdProp` on the panel row → observer pushes URL entry. Symmetric with link clicks.
- Browser back after a chevron click: undoes the chevron click via the URL → applyCurrentUrl → row revert. Local stack would now be out of sync with actual panel state.
- **Reconciliation on popstate: stacks AND VisitState.** On inbound URL apply, for each panel whose `topLevelBlockId` changed, walk its local back/forward stack:
  - If new block matches top of back stack: pop back, push old to forward; the matched entry's `VisitState` drives the restore.
  - If new block matches top of forward stack: pop forward, push old to back; same VisitState restore.
  - Else (stack diverged from URL — user jumped via external nav): drop the local stack, start fresh from current. VisitState for that panel is lost on this hop; not regression vs today.
- **VisitState restoration splits like step 3 does:** `focusedBlockLocationProp` is written synchronously in the same `applyCurrentUrl` tx that sets `topLevelBlockIdProp`, so the new render starts with the right cursor (no mid-render flash). `scrollTop` is queued via `panelHistory.enqueueRestore(rowId, {scrollTop})` and consumed by PanelRenderer's existing post-layout `consumeRestore` effect — scroll has to wait for the new content to lay out. This is exactly the split `goBackInPanel` already uses for chevron clicks; we extend the same write pattern to the popstate path. (`consumeRestore` doesn't need to grow new responsibilities — it stays scroll-only.)

This keeps step 3's "focused block + scroll restore on back" guarantee intact for the now-primary path (browser back over intra-panel nav). Promoting the stack to DB rows for cross-reload survival: deferred, same trade-off as before (matches browser tab behavior).

### Workspace switch + default landing

URL `#<wsId>` (no block list) doesn't mean "render blank." Current bootstrap (App.tsx ~line 181, `getInitialBlock`) eagerly resolves missing block id to today's daily note and writes `#<wsId>/<dailyNoteId>` via `writeAppHash`. **That eager rewrite has to be removed in step 4** — it would race the projection's "restore prior layout" path and clobber it before `applyCurrentUrl` gets a look in.

Refactored landing flow (replaces the eager-daily-note rewrite):

- The **parser** stays pure: `parseLayout('#<wsId>')` → `{workspaceId, blockIds: []}`. It doesn't know about defaults.
- On bare `#<wsId>` (initial load OR workspace switch), `applyCurrentUrl` looks up panel rows for `(layoutSessionId, newWsId)`:
  - **If rows exist** (user has visited this workspace in this layout session before): build URL `#<newWsId>/<block1>/<block2>/...` from those rows and `replaceState` to it, no row writes. Net effect: bare `#<newWsId>` is treated as "go to this workspace, restore my last layout for it." `replaceState` (not push) collapses the bare URL into the full one without doubling the history entry.
  - **If no rows exist** (first time visiting in this layout session): the **landing layer** sitting alongside the projection resolves today's daily note, does `history.replaceState(_, _, buildLayout(wsId, [dailyNoteId]))`, then `repo.tx(UiState, tx => insertPanelRow(dailyNoteId))`. The replaceState lands first so the projection's idempotency rule kicks in: row write fires the observer, observer builds the same URL, no-ops. One history entry, URL `#<wsId>/<dailyNoteId>`, no ping-pong on browser back.
- **App/Suspense handoff.** `getInitialBlock` no longer resolves a single "landing block." Its replacement returns `{workspaceId, layoutSessionBlock}` once URL + layout-session rows are normalized, and *that's* what App passes to the layout host. Concretely:
  - `getInitialBlock` (or its renamed successor): resolves the workspace, ensures the layout-session block exists, runs `applyCurrentUrl`, then if the layout-session block still has no children defers to the landing layer (replaceState `#<wsId>/<dailyNoteId>` + insert row); awaits all of the above before resolving. Returns `{workspaceId, layoutSessionBlock}`.
  - `LayoutRenderer` (or whatever the top-level layout host is) takes `layoutSessionBlock` as its prop instead of a single landing block, and reads `useChildren(layoutSessionBlock)` for the panel list. No "give me one block to render" handoff; the layout host always works from the layout-session block.
  - Net effect: TopLevelRenderer never receives a "main block" id from bootstrap; the entry block is whatever ends up at `layoutSessionBlock.children[0]?.topLevelBlockIdProp`. Avoids accidentally keeping a vestigial daily-note bootstrap path just to satisfy a rendering contract that no longer applies.
- The Suspense boundary keeps working — the resolved promise gates first paint, just resolves to the layout-session block now instead of a single landing block.
- **Workspace switch path:** caller writes `#<newWsId>` to URL (`writeAppHash` is fine). Same flow as above runs.
- Per-(layoutSessionId, wsId) row persistence means each layout session maintains its own per-workspace layout history. Switching back and forth between two workspaces in one layout session restores each side's layout. Other layout sessions' rows are unaffected.

Keeps the "always land on something" UX, keeps the parser dumb, keeps the projection narrow, and keeps the "DB row write drives URL" property — bootstrap is the one place that pre-writes the URL because it explicitly wants replace-not-push semantics for what would otherwise look like an insert.

### Main panel = first ordered child of layout-session block

Today the "main" panel is identified by `panel.content === MAIN_PANEL_NAME` ('main'), a sentinel value written by `ensureMainPanel`. With the layout-session parent layout, this stops being meaningful: there's no need for a sentinel-content row, and the leftmost panel can naturally change identity (close-of-leftmost, drag-reorder).

New semantics: **main panel = first child of the layout-session block by order key.** Positional, no special content. Implications across the codebase:

- **`ensureMainPanel`** (LayoutRenderer): deleted. The landing layer's row insert (or any user nav that produces the first row) creates whatever block becomes "main" for that `(layoutSessionId, wsId)`. No sentinel row.
- **`MAIN_PANEL_NAME` + `isMainPanel(block)` content check** (globalState, PanelRenderer, navigation, defaultShortcuts, tests): replaced with a positional helper, e.g. `isMainPanel(block, layoutSessionBlock) → block.id === layoutSessionBlock.children[0]?.id`. Memoized at the appropriate scope.
- **PanelRenderer's chrome-hiding** (close button, back/forward chevrons currently hidden on main): now driven by the positional check. If user reorders panels so a different one becomes leftmost, chrome hides on the new leftmost.
- **`target: 'main'`** in `NavigateInput` (alt-click): updates `topLevelBlockIdProp` on the first child of the layout-session block, regardless of which panel the click came from.
- **Default shortcuts** that branch on `isMainPanel(uiStateBlock)`: same swap to positional check.

The "first child = main" rule fits the URL semantic ("leftmost = focused/main panel"). Drag-reorder and close-of-leftmost both shift the main role to whatever ends up first; mental model matches.

### Mobile

Render only the last (focused) panel for the current layout session. **Close button does a proper close** — deletes the visible panel's row through the same path desktop's `handleClose` uses (UiState delete; observer pushes URL update). Earlier draft of this section said "close button = browser back" which doesn't hold under "push on every URL change" — browser back could undo an intra-panel link click or chevron click instead of closing the visible panel, which is the wrong affordance for a control that visually says "close." Pure renderer change; data model unchanged.

### Legacy panel-block rows in existing user DBs

Ignore (alpha). Existing panel rows under `ui-state/panels/` are not children of any layout-session block — they're effectively orphaned by the new readers. Optional one-shot cleanup if cruft becomes an issue (delete the legacy `panels` subtree once we're confident nothing reads from it).

### Cmd+[/], forward/back mouse buttons

Stay bound to `window.history.back()` / `forward()`. With "push on every URL change," browser history is the universal navigation timeline — these keys undo/redo the most recent navigation regardless of level (open-panel, close-panel, intra-panel link click, chevron click, workspace switch). User-facing meaning is "back/forward through anything I just did," which matches both web-conventional expectations and the keys' usual semantics in browsers.

Per-panel chevrons remain a separate panel-scoped affordance.

### Modifier-key policy for block link clicks (incl. "open in main")

Current matrix (from `handleBlockLinkClick`):

| Modifier | Action | Resulting `navigate()` call |
|---|---|---|
| plain click | navigate within current panel | `{target: 'focused', panelId}` |
| shift-click | open in Roam-sidebar stack | `{target: 'sidebar-stack', sourcePanelId}` |
| shift+alt-click | open in new (side) panel | `{target: 'new-panel', sourcePanelId}` |
| cmd / ctrl / middle / right | fall through to native `<a href>` (new browser tab etc.) | none |

Adding **"open in main panel"** — useful when browsing in a side panel and wanting to focus the link as the new main: navigate the leftmost panel's row to the clicked block, regardless of which panel the click came from. Expressed in `NavigateInput` as a new `target: 'main'`.

Modifier choice: **alt-click** as default. Reasoning:

- Cmd-click is the universal "open in new browser tab" convention; overriding it costs users that affordance for any block link in the app. High-tax override.
- Shift is taken (new panel).
- Alt-click currently falls through to native (which on most browsers is "save link," rarely used inside an SPA). Lowest-tax modifier to repurpose.
- If alt-click ends up unergonomic, swapping to cmd-click is a one-line change in `handleBlockLinkClick`.

Updated matrix:

| Modifier | Action |
|---|---|
| plain | focused (current panel) |
| shift | **Roam-sidebar stack** |
| shift+alt | new side panel |
| alt | **main panel** (new) |
| cmd / ctrl | native browser behavior (new browser tab) |
| middle / right | native |
| shift+alt wins over plain shift | preserves the old side-panel behavior behind an explicit chord |

Push semantics: alt-click changes the main panel's `topLevelBlockId` → observer pushes a URL entry. Browser back undoes the alt-click. Symmetric with the rest.

## Step 4 execution plan

### 4a. URL parser/builder + layout-session block infrastructure

- Extend `routing.ts`: `parseLayout(hash) → {workspaceId, blockIds: string[]}`, `buildLayout(workspaceId, blockIds) → hash`. Bare-id + `/`-separated only; structure to allow extending to `()` groups without breaking the API.
- New `layoutSessionId.ts`: `getLayoutSessionId()` reads/generates UUID in `sessionStorage['ws-nav.layoutSessionId']` for browser tabs and `localStorage['ws-nav.installedAppLayoutSessionId']` for installed app display modes, memoized.
- New `getLayoutSessionBlock(uiState, layoutSessionId)` in `globalState.ts` (alongside the existing `getPanelsBlock`): `ensureUiChild(uiState, 'layout-sessions')` then `ensureUiChild(layoutSessionsBlock, layoutSessionId)` to find-or-create the layout-session parent block. Memoized like the existing helpers.
- Add `usePanelsForLayoutSession()` hook that resolves the layout-session block for the current `(workspaceId, layoutSessionId)` and returns `useChildren(layoutSessionBlock)`.
- Tests: parser round-trips (including empty-list, single-block, multi-block); layoutSessionId persistence across the same module's lifetime; browser-tab layout sessions stay independent by storage instance; installed app display modes use the localStorage-backed id; layout-session block is created on first access and reused on subsequent accesses for the same layoutSessionId; two simulated layoutSessionIds produce independent layout-session blocks.

No behavior change yet — the parser/layoutSessionId/layout-session-block infrastructure exists but nothing reads the URL or writes through the layout-session block.

### 4b. URL ↔ panel-row projection (observer-shaped, two directions)

Panel rows are the source of truth; URL is a derived view. The projection is the single place that translates between them — narrow and centralized in implementation, but it does *not* require callers to declare intent. Any path that writes panel rows via `repo.tx` gets the URL update for free, including paths we haven't written yet. This preserves the property that DB rows drive everything.

The reviewer's worry — "observer can't tell open-panel from reorder, or close from workspace-switch fallout" — is answered by classifying the **diff between row states**, not the caller's intent. With "push on every URL change" the rule is simple:

| Diff (prev rows → next rows) for `(workspaceId, layoutSessionId)` | History mode |
|---|---|
| ordered list of `topLevelBlockId`s changed (the URL-encoded view of the rows) | `pushState` |
| only other props changed (`scrollTop`, `focusedBlockLocation`, …) | no URL write |
| computed URL already matches `location.hash` | no-op (idempotent) |

(Row IDs themselves are not URL-visible — they're identity for state preservation, not part of the URL. The URL only encodes the ordered `topLevelBlockId`s.)

Idempotency is what handles the bootstrap-landing edge case: bootstrap `history.replaceState`s the URL to `#<wsId>/<dailyNoteId>` *before* writing the row, then writes the row in a UiState tx — the observer fires, builds the same URL, and skips. This is the only path that gets `replaceState` in step 4.

`panelLayoutProjection.ts` shape:

```ts
panelLayoutProjection = {
  // Inbound: external URL change (back/forward, user typed URL, programmatic
  // location.hash assignment). Internally listens to hashchange + popstate
  // because pushState/replaceState fire neither.
  applyCurrentUrl(): Promise<void>

  // Outbound: subscribed to panel-row commits for (currentWorkspaceId,
  // currentLayoutSessionId). On each commit, diffs prev vs next, picks history mode,
  // writes URL via pushState/replaceState, then notifies subscribers.
  // No public method — wired up at construction.

  // For components that previously subscribed to hashchange. Fires on any
  // change the projection is aware of:
  //   1. Inbound URL change applied to rows (hashchange/popstate → applyCurrentUrl
  //      writes rows).
  //   2. Inbound URL normalization that writes URL but not rows (bare #<wsId>
  //      with existing rows → replaceState to the full layout, no row write).
  //   3. Outbound URL change after a row commit (observer writes pushState).
  // Cases 1 and 3 cover row-shape changes; case 2 is URL-shape-only but still
  // a state change components may care about (e.g., URL bar / share-link
  // displays would be stale otherwise).
  subscribe(listener): unsubscribe
}
```

Operational details:

- **Async / serialization.** `applyCurrentUrl` returns `Promise<void>` (it does a `repo.tx` internally). The projection serializes inbound passes via an internal chained promise — multiple `hashchange` events while one is in flight queue rather than racing. Outbound (row → URL) runs synchronously after a tx commit, no race with itself.
- **Loop guard.** A re-entrancy flag wraps both directions: outbound URL write sets the flag, the resulting `hashchange` (if any) sees the flag and skips `applyCurrentUrl`. Inbound `applyCurrentUrl`'s row writes set the flag too, so the outbound observer skips when it sees its own writes.
- **Per-tx granularity.** The outbound observer subscribes at the *tx-commit* level (single notification per `repo.tx`), not per-property-update — multiple writes in one tx produce one URL update.
- **LCS over block ids has duplicate-block ambiguity.** If the URL contains `b1` twice (`#wsId/b1/b2/b1`), and a close removes one of them, browser-back can't unambiguously restore which prior rowId was at which position. **Decision: best-effort.** Duplicates that survive a round-trip get fresh rowId (and lose per-row visit state on that round-trip). Upgrade path if this bites: write `{rowOrder: rowId[]}` into `history.state` on each push so popstate has unambiguous identity recovery — `history.state` survives reload and is per-entry. Not in step 4.
- **No "intent hints" channel.** Callers don't pass `{kind: 'open-panel'}` or similar. They just write rows.
- **`LayoutRenderer` reads through `useChildren(layoutSessionBlock)`** where `layoutSessionBlock = ui-state/layout-sessions/{currentLayoutSessionId}` (resolved via the existing `ensureUiChild` pattern, see "Layout-session scoping" above). No filter — children of the right parent are already the right rows. Order-key ordering is per-parent so each layout session's panel order is independent. Considered shared-parent + `layoutSessionIdProp` filter and rejected: requires a filter on every render, and GC becomes a per-row scan/delete instead of one cascading subtree delete per stale layout session.
- **`navigate()`** continues to insert a panel row via `repo.tx` (UiState scope); URL update happens through the observer.
- **Tests:** classification rule covers each diff shape (insert/delete/reorder/intra-panel/property-only/no-op); `applyCurrentUrl` reconciles rows correctly across append/close/insert-in-middle/full-replace; reload restores layout; reorder preserves rowId; duplicate-block round-trips get fresh identity (documented best-effort); two simulated layoutSessionIds don't see each other; subscribers fire after each of (a) inbound URL→rows, (b) inbound URL-only normalization (bare `#<wsId>` with existing rows → replaceState to full layout), (c) outbound rows→URL; rapid open/close calls converge correctly under serialization.

### 4c. Wire `navigate()` and close through panel-row writes

Callers don't talk to the projection directly — they write panel rows. The projection's row→URL observer takes care of the URL. This keeps the "DB row write triggers URL update" property and means future code paths that mutate panel rows get URL updates automatically.

- `navigate({target: 'new-panel', sourcePanelId})`: insert a new panel row at `sourceIndex + 1` (UiState scope). Observer classifies as insert → push. Drop `dispatchEvent('open-panel')` from `navigation.ts`; drop `'open-panel'` CustomEvent listener from `LayoutRenderer`.
- `handleClose` in `PanelRenderer`: stays as-is (UiState delete of the panel row). Observer classifies as delete → push.
- `navigate({target: 'focused', panelId})` for a side panel: updates the panel row's `topLevelBlockIdProp`. Observer classifies as URL-changed → push (browser back undoes the link click).
- Workspace switch: existing path writes `#<new-wsId>` to URL via `location.hash =` (or its `writeAppHash` wrapper). The inbound side of the projection (`applyCurrentUrl`) handles bare `#<wsId>` by either restoring prior `(layoutSessionId, wsId)` rows or, if none exist, deferring to the landing layer to fill in the daily note (see "Workspace switch + default landing" above). App.tsx's eager daily-note rewrite in `getInitialBlock` is removed in this step.
- Cmd-[/], forward/back mouse: keep bound to `history.back/forward()` — gets the right semantics for free now that browser history tracks panel layout.

### 4d. Visit state persistence (scroll)

- Add `scrollTopProp` (UiState, number-or-null) to panel block schema.
- `PanelRenderer`:
  - On scroll: debounced write of `scrollRef.current.scrollTop` to row.
  - On `visibilitychange` to hidden: flush pending write.
  - On mount + `topLevelBlockId` change: read `scrollTopProp` from row and apply to scrollRef in a post-layout effect (same pattern as the existing `consumeRestore`).
- Existing in-memory snapshotter / restore queue stays — it's still the right substrate for *intra-session* per-panel back/forward, where we don't want every nav writing to DB.
- Tests: scroll persists across reload; stays out of the undo stack (UiState, not undoable); doesn't pollute another layout session's row.

### 4e. Cleanup

- Delete `'open-panel'` CustomEvent (event name + dispatcher + listener).
- **Delete `ensureMainPanel`, `MAIN_PANEL_NAME`, and the content-based `isMainPanel`.** Replace `isMainPanel` with a positional helper (first child of layout-session block); update PanelRenderer chrome-hiding, default shortcut branches, and navigation routing call sites accordingly. See "Main panel = first ordered child of layout-session block" above.
- Update tests that reference `MAIN_PANEL_NAME` / panel-content-as-sentinel to use positional setup instead.
- Delete the legacy `getPanelsBlock` / `PANELS_PATH_PART` indirection if nothing reads from `ui-state/panels` anymore.
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
- Per-device panel layout: not separately scoped. UiState rows sync through PowerSync like any block row, so panel layout (and focus/scroll restore) is shared across a user's devices by design — see the correction note at the top.
- GC of orphan layout-session subtrees: not in step 4. Add a heartbeat-based sweep if/when this becomes a real issue (one cascading delete per stale layout session).

## Relation to Riffle's prelude

The previous draft of this plan introduced a parallel in-memory `panelLayoutStore`. That deviated from Riffle's substrate-uniformity principle for no real gain — `ChangeScope.UiState` already provides a dedicated, not-undoable scope for this kind of state (it still syncs through the normal substrate — see the correction note at the top). The current plan stays inside the existing reactive substrate; URL and `sessionStorage` are projections, not separate state authorities.

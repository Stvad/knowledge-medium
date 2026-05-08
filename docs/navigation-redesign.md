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
- On first load: read `sessionStorage['ws-nav.tabId']`; if missing, generate a UUID and store it. (Browsers don't expose a native tab id — `window.name` is the closest but unsafe to share with frames/scripts; Service Worker client ids are per-document and only visible inside the SW. Storing a UUID in `sessionStorage` is the canonical pattern.)
- Layout query filters panel rows to `(workspaceId, tabId)`. Each tab renders its own slice.
- Reconciliation writes are scoped to current `tabId`.

GC of orphan rows (tab closed → its rows linger): punt for alpha. Can add a localStorage-heartbeat-based sweep later. Worst case: rows accumulate; they're tiny and UiState-scoped, so no sync impact.

### URL shape (no back-compat constraint — old shape can break)

```
#<wsId>/<blockId1>(/<blockId2>(/<blockId3>...))*
```

Flat ordered list, leftmost = focused/main panel, no special focused-vs-panels suffix. Empty list (`#<wsId>`) is a transient state — bootstrap fills in today's daily note on workspace landing (see "Workspace switch + default landing" below). Compact, shareable, human-readable.

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
current panel stack    #wsId/b1/b2/b3
tabs in second slot    #wsId/b1/(b2,b3)/b4
horizontal split       #wsId/(h:b1,b2)
nested                 #wsId/b1/(h:(v:b2,b3),b4)
```

Step 4 only ships the bare-id + `/`-separated case. Adding `()` groups later is a parser extension, not a breaking change — every URL that worked before keeps working. Layout-id (`#wsId/L7` pointing at a stored layout) stays available as an opt-in for *named* saved layouts; not the default transport.

### Slot identity = panel rowId

Panel rows are the source of truth; their rowId is the slot identity. Survives reload (DB persists), survives intra-panel navigation, naturally extends to splits/tabs (those would just be additional row types).

URL ↔ DB reconciliation on hashchange: LCS diff matches URL block list to existing panel rows for `(workspaceId, tabId)`, preserving per-row state where blocks survive. Insert-in-middle, append, close, intra-panel nav all work; the LCS does the same job it did in the in-memory-store version, just over DB rows.

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

- We can't use `location.hash = X` for the replace-state case (intra-panel nav) — it always pushes. Must use `replaceState`.
- `pushState` / `replaceState` notify *no one*. The projection has to call its own subscribers after writing.
- For external URL changes (back/forward, user typing in URL bar, other tabs writing the hash via `BroadcastChannel`-like mechanisms), we need to listen to **both** `hashchange` and `popstate` — `hashchange` alone misses pushState-based history entries when both endpoints have the same hash (rare for us but possible), and `popstate` alone misses external `location.hash` writes.
- Existing `useHash` (`hashchange` only) is enough for today's `writeAppHash` (which uses `location.hash =`). After step 4, components stop subscribing to `hashchange` directly and instead subscribe to the projection — which internally listens to both events and emits a single normalized change.

### Visit state (focused block, scroll) — persist via UiState properties

Already partially shipped in step 3 as in-memory snapshots on panel-history entries. Promote to DB-backed:

- `focusedBlockIdProp` — already a UiState property on panel rows. Keep.
- `scrollTopProp` — new. UiState property on panel rows. Written debounced on scroll (after scroll-stop, ~200ms) and on `visibilitychange`. Read on mount, applied to scroll ref after layout.

Reload-survival of focus + scroll is now free, since DB rows persist and `tabId` scopes them per-tab.

### Per-panel back/forward block history — keep in-memory, reconcile on popstate

`panelHistory` (back/forward stacks of `{blockId, VisitState}` per panel) stays in-memory. Matches browser tab back-stack semantics: dies with the session.

Interaction with browser history (now that intra-panel nav pushes too):

- Click chevron back in panel 1: pop from panel 1's local back stack, push to its forward stack. Updates `topLevelBlockIdProp` on the panel row → observer pushes URL entry. Symmetric with link clicks.
- Browser back after a chevron click: undoes the chevron click via the URL → applyCurrentUrl → row revert. Local stack would now be out of sync with actual panel state.
- Reconciliation on popstate: on inbound URL apply, compare each panel's new `topLevelBlockId` to its local stack. If new block matches the top of back stack, pop it (we went back); if it matches top of forward, pop forward and push to back (we went forward); else, the local stack got out of sync (e.g., user opened a new history entry from elsewhere) — drop the stack and start fresh from current.

This keeps the affordance useful within a session while making it tolerant of browser back/forward interleaving. Promoting the stack to DB rows for cross-reload survival: deferred, same trade-off as before (matches browser tab behavior).

### Workspace switch + default landing

URL `#<wsId>` (no block list) doesn't mean "render blank" — current bootstrap (App.tsx ~line 181, `getInitialBlock`) treats missing block id as "land on today's daily note" and writes the full hash back via `writeAppHash`. We keep that behavior. Resolution:

- The **parser** is still pure: `parseLayout('#<wsId>')` → `{workspaceId, blockIds: []}`. It doesn't know about defaults.
- The **landing layer** (existing bootstrap, sits above the projection) detects `blockIds: []` after `applyCurrentUrl` settles and resolves today's daily note. It then does both: `history.replaceState(_, _, buildLayout(wsId, [dailyNoteId]))`, then `repo.tx(UiState, tx => insertPanelRow(dailyNoteId))`. The replaceState lands first so the projection's idempotency rule kicks in: row write fires the observer, observer builds the same URL, no-ops. Net effect: one history entry, URL `#<wsId>/<dailyNoteId>`, no ping-pong on browser back.
- **Workspace switch path:** caller writes `#<newWsId>` to URL (existing `writeAppHash` is fine). The inbound `applyCurrentUrl` reconciles rows for `(tabId, newWsId)`, finds none, the landing layer detects empty and does the replaceState+insert dance for the new workspace's daily note. Other tabs' rows are unaffected.

Keeps the "always land on something" UX, keeps the parser dumb, keeps the projection narrow, and keeps the "DB row write drives URL" property — bootstrap is the one place that pre-writes the URL because it explicitly wants replace-not-push semantics for what would otherwise look like an insert.

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

### 4b. URL ↔ panel-row projection (observer-shaped, two directions)

Panel rows are the source of truth; URL is a derived view. The projection is the single place that translates between them — narrow and centralized in implementation, but it does *not* require callers to declare intent. Any path that writes panel rows via `repo.tx` gets the URL update for free, including paths we haven't written yet. This preserves the property that DB rows drive everything.

The reviewer's worry — "observer can't tell open-panel from reorder, or close from workspace-switch fallout" — is answered by classifying the **diff between row states**, not the caller's intent. With "push on every URL change" the rule is simple:

| Diff (prev rows → next rows) for `(workspaceId, tabId)` | History mode |
|---|---|
| any row data that affects URL changed (rowIds, order, `topLevelBlockId`) | `pushState` |
| only other props changed (`scrollTop`, `focusedBlockId`, …) | no URL write |
| computed URL already matches `location.hash` | no-op (idempotent) |

Idempotency is what handles the bootstrap-landing edge case: bootstrap `history.replaceState`s the URL to `#<wsId>/<dailyNoteId>` *before* writing the row, then writes the row in a UiState tx — the observer fires, builds the same URL, and skips. This is the only path that gets `replaceState` in step 4.

`panelLayoutProjection.ts` shape:

```ts
panelLayoutProjection = {
  // Inbound: external URL change (back/forward, user typed URL, programmatic
  // location.hash assignment). Internally listens to hashchange + popstate
  // because pushState/replaceState fire neither.
  applyCurrentUrl(): Promise<void>

  // Outbound: subscribed to panel-row commits for (currentWorkspaceId,
  // currentTabId). On each commit, diffs prev vs next, picks history mode,
  // writes URL via pushState/replaceState, then notifies subscribers.
  // No public method — wired up at construction.

  // For components that previously subscribed to hashchange. Fires on any
  // change the projection is aware of (inbound URL change applied to rows,
  // or outbound URL change after row commit).
  subscribe(listener): unsubscribe
}
```

Operational details:

- **Async / serialization.** `applyCurrentUrl` returns `Promise<void>` (it does a `repo.tx` internally). The projection serializes inbound passes via an internal chained promise — multiple `hashchange` events while one is in flight queue rather than racing. Outbound (row → URL) runs synchronously after a tx commit, no race with itself.
- **Loop guard.** A re-entrancy flag wraps both directions: outbound URL write sets the flag, the resulting `hashchange` (if any) sees the flag and skips `applyCurrentUrl`. Inbound `applyCurrentUrl`'s row writes set the flag too, so the outbound observer skips when it sees its own writes.
- **Per-tx granularity.** The outbound observer subscribes at the *tx-commit* level (single notification per `repo.tx`), not per-property-update — multiple writes in one tx produce one URL update.
- **LCS over block ids has duplicate-block ambiguity.** If the URL contains `b1` twice (`#wsId/b1/b2/b1`), and a close removes one of them, browser-back can't unambiguously restore which prior rowId was at which position. **Decision: best-effort.** Duplicates that survive a round-trip get fresh rowId (and lose per-row visit state on that round-trip). Upgrade path if this bites: write `{rowOrder: rowId[]}` into `history.state` on each push so popstate has unambiguous identity recovery — `history.state` survives reload and is per-entry. Not in step 4.
- **No "intent hints" channel.** Callers don't pass `{kind: 'open-panel'}` or similar. They just write rows.
- **Existing `LayoutRenderer`** keeps reading `panelBlock.children`; those children are kept in sync with URL via the projection.
- **`navigate()`** continues to insert a panel row via `repo.tx` (UiState scope); URL update happens through the observer.
- **Tests:** classification rule covers each diff shape (insert/delete/reorder/intra-panel/property-only/no-op); `applyCurrentUrl` reconciles rows correctly across append/close/insert-in-middle/full-replace; reload restores layout; reorder preserves rowId; duplicate-block round-trips get fresh identity (documented best-effort); two simulated tabIds don't see each other; subscribers fire after both inbound and outbound passes; rapid open/close calls converge correctly under serialization.

### 4c. Wire `navigate()` and close through panel-row writes

Callers don't talk to the projection directly — they write panel rows. The projection's row→URL observer takes care of the URL. This keeps the "DB row write triggers URL update" property and means future code paths that mutate panel rows get URL updates automatically.

- `navigate({target: 'new-panel', sourcePanelId})`: insert a new panel row at `sourceIndex + 1` (UiState scope). Observer classifies as insert → push. Drop `dispatchEvent('open-panel')` from `navigation.ts`; drop `'open-panel'` CustomEvent listener from `LayoutRenderer`.
- `handleClose` in `PanelRenderer`: stays as-is (UiState delete of the panel row). Observer classifies as delete → push.
- `navigate({target: 'focused', panelId})` for a side panel: updates the panel row's `topLevelBlockIdProp`. Observer classifies as URL-changed → push (browser back undoes the link click).
- Workspace switch: existing path writes `#<new-wsId>` to URL via `location.hash =` (or its `writeAppHash` wrapper). The inbound side of the projection (`applyCurrentUrl`) reconciles rows for the new `(tabId, newWsId)`; landing layer fills in the daily note (see below).
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

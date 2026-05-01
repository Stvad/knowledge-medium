# Perf spike trial results

## Environment

- Vite dev server, React 19.2, React Compiler enabled (CRITICAL — see findings)
- React StrictMode active in dev → every BlockComponent mounts twice; `mounts` numbers are 2× the real mount-count, `live` is the real count.
- Synthetic data seeded into the live PowerSync repo via `repo.mutate.insertChildren`.
- Mount counter: `useEffect` in [BlockComponent](src/components/BlockComponent.tsx).

## Trials

### Initial-render mounts (after page load + stability window)

| Shape          | Blocks | Mode  | Live BlockComponents | DOM `.tm-block` | scrollHeight | Settled in |
|----------------|--------|-------|----------------------|-----------------|--------------|------------|
| small (d2 b6)  | 43     | tree  | 47                   | 43              | 1,227 px     | <1 s      |
| small          | 43     | virt  | 47                   | 43              | 1,290 px     | <1 s      |
| small          | 43     | lazy  | 47                   | 43              | 1,227 px     | ~1 s      |
| medium (d3 b7) | 400    | tree  | **404**              | 400             | 10,911 px    | ~3 s      |
| medium         | 400    | virt  | **57**               | 53              | 22,254 px    | <1 s      |
| medium         | 400    | lazy  | **40 → 267 cascading** | 263 after settle | 11,570 px | ~30 s    |
| large-deep (d5 b4) | 1,365 | tree  | **1,369**         | 1,365           | 37,147 px    | ~12 s     |
| large-deep     | 1,365  | virt  | **58**               | 54              | 80,118 px    | <1 s      |
| large-deep     | 1,365  | lazy  | **120 → 244 cascading** | 240 after scroll | 10,390 px | ~29 s   |

**Mount reduction (initial / steady state):**

|         | Tree | Virt | Lazy (initial) | Lazy (settled) |
|---------|------|------|----------------|----------------|
| medium  | 404  | 57   | 40             | 267            |
| large-deep | 1,369 | 58 | 120         | 244            |

`Virt` is the clear winner on raw mount count and stays flat regardless of tree size. `Lazy` mounts more than virt because every visible block immediately renders all of *its* children as placeholder divs, and any placeholder within the 600 px overscan margin then upgrades to a real mount — the cascade keeps unfolding for tens of seconds after page load.

### Scroll behavior (large-deep, 4× 800 px steps with 600–800 ms wait)

| Mode | Per-step new mounts | Page responsive? |
|------|---------------------|------------------|
| tree | (already all mounted) | **No — main thread blocked >5 s on scroll** |
| virt | ~50 in bursts when overscan boundary crosses | Bursty stalls during the burst |
| lazy | **~22 evenly per step** | **Smooth incremental mounts** |

Lazy gives the smoothest *interactive* feel because mounts spread across many small intersections; virt batches per-row-window into single bursts; tree just freezes.

## Findings (in order of importance)

### 1. React Compiler silently breaks anything driven by external observers

`vite.config.ts` enables `babel-plugin-react-compiler`. The compiler over-memoizes components, which discards state updates dispatched from outside React's render path:

- Virtuoso/tanstack receive correct props but never re-render on scroll.
- IntersectionObserver→`setState` callbacks in LazyBlockComponent get dropped, leaving the placeholder frozen.

Fix: file-level `'use no memo'` directive. Both [VirtualizedBlockTree.tsx](src/components/renderer/VirtualizedBlockTree.tsx) and [LazyBlockComponent.tsx](src/components/LazyBlockComponent.tsx) carry it. **You should audit other files that integrate stateful third-party libs** (CodeMirror wrappers, Radix portals, animation libs).

### 2. Initial-load wins are huge — both approaches solve the user's "wcs/plan locks up" problem

- Virt: 24× fewer mounts at 1,365 blocks (58 vs 1,369).
- Lazy initial: 11× fewer mounts at 1,365 blocks (120 vs 1,369), but cascades up to 244 within ~30 s of idle time.

Both are night-and-day over the legacy recursive renderer.

### 3. Trade-offs between virt and lazy

| Property | Virt (`@tanstack/react-virtual`) | Lazy (`IntersectionObserver`) |
|---|---|---|
| Tree structure | **Flattened** (manual depth + indentation) | **Preserved** (natural recursion) |
| Backlinks/footer placement | Wrong by default (renders between block and its descendants) — needs fix | **Correct** (after children, naturally) |
| Suppress-children gymnastics | Required (`suppressChildren` context) | Not needed |
| Initial mounts | **Lowest** (~50, flat) | Higher (~120, then cascades) |
| Steady-state mounts | Stays flat | Cascades up over time |
| Scroll smoothness | Bursty (mount window per overscan crossing) | **Smooth** (incremental) |
| Scroll wedge | Possible on fast programmatic scrolls (rAF starvation) | Not observed |
| Total scroll height accuracy | Estimated (until measured) — large gap | **Real** (DOM-driven, but only as far as unfolded) |
| Code added | ~140 lines (VBT + flatten + virtualizer wiring) | ~50 lines (LazyBlockComponent) |
| React Compiler | Needs escape hatch | Needs escape hatch |
| Search-in-page (Cmd-F) | Misses anything off-screen | Misses anything off-screen (but tree mode does too once things are huge) |

### 4. Per-block mount cost is the next bottleneck for *both*

Both approaches surface the same finding: `BlockComponent` mounts are individually expensive (~10 `useHandle` subscriptions, breadcrumbs/properties/footer chain). 50 mounts in a single scroll burst can stall a frame regardless of which approach we pick. Fixing this (smaller per-block subscription footprint, or pushing focus/selection through a targeted dispatcher) would amplify both approaches.

## Recommendation

**Lazy is the better fit for this codebase**:

- Keeps the existing recursive render tree as the source of truth — no flattening, no suppress-children, no manual indentation, no separate scroll-element bookkeeping.
- Backlinks/footer ordering is automatically correct.
- Smooth incremental scroll mounts (no bursts).
- Drops mount count by an order of magnitude on initial load — enough to make the "wcs/plan locks up" problem go away.

Virt is more aggressive on the absolute mount count (and stays flat at ~50) but the cost is real architectural commitment to a flat-list render and a separate set of edge cases (header/footer rows, scroll-restoration, search-in-page, etc.).

## Files touched (summary)

- [src/components/renderer/VirtualizedBlockTree.tsx](src/components/renderer/VirtualizedBlockTree.tsx) — virt impl
- [src/components/LazyBlockComponent.tsx](src/components/LazyBlockComponent.tsx) — lazy impl
- [src/components/renderer/PanelRenderer.tsx](src/components/renderer/PanelRenderer.tsx) — flag-gated mode selection
- [src/components/BlockComponent.tsx](src/components/BlockComponent.tsx) — `BlockChildren` reads `lazyChildren` flag; mount counter
- [src/components/renderer/DefaultBlockRenderer.tsx](src/components/renderer/DefaultBlockRenderer.tsx) — `suppressChildren` short-circuit (virt mode only)
- [src/types.ts](src/types.ts) — `suppressChildren` + `lazyChildren` on `BlockContextType`
- [src/App.tsx](src/App.tsx) — dev-only `window.__app` instrumentation
- `package.json` — `+@tanstack/react-virtual`

## Toggling

```js
localStorage.setItem('renderMode', 'tree')   // legacy recursive
localStorage.setItem('renderMode', 'virt')   // tanstack flat-list
localStorage.setItem('renderMode', 'lazy')   // recursive + intersection observer
localStorage.removeItem('renderMode')         // default = 'virt'
location.reload()
```

Backwards-compat: `localStorage.virt = '0'` still selects `tree`.

### Scroll behaviour

| Trial | What happened |
|---|---|
| medium tree, programmatic scroll 8000 px over 1.5 s | **1 frame fired in 6,062 ms.** Single frame blocked main thread for 5,879 ms. Page essentially frozen during scroll. |
| medium virt, programmatic scroll 3000 px in 800 ms | Wedged similarly — rAF starved (15s timeout). Cause: each scroll-driven re-render mounts ~50 BlockComponents in a single batch, and per-block mount cost dominates. |
| large-deep virt, discrete scroll-step test (800→3200 px in 4 steps × 600 ms wait) | Completed in 4.3 s. Mounts arrive in bursts of ~50 when viewport crosses the overscan boundary. Each burst is the heavy moment. |

## Findings (in order of importance)

### 1. React Compiler silently breaks virtualizers — fixed with `'use no memo'`

Both `react-virtuoso` and `@tanstack/react-virtual` initially appeared to "render the wrapper but never display rows". Spent considerable time chasing what looked like a Virtuoso bug. The actual cause: `vite.config.ts` enables `babel-plugin-react-compiler`, which over-memoizes the virtualizer component and discards the internal state updates that the libraries dispatch on scroll/resize.

Fix in [VirtualizedBlockTree.tsx](src/components/renderer/VirtualizedBlockTree.tsx):
```ts
'use no memo'
```

After this directive, the virtualizer re-renders on scroll as expected. **Anywhere else in the codebase that integrates a third-party state-machine component (CodeMirror wrappers, Radix portals, animation libs) should be checked for the same failure mode.**

### 2. Virtualization fixes initial-load mount cost dramatically (7×–24×)

This was the user's primary complaint: navigating to wcs/plan locks up the page. The data confirms: with 1,365 blocks, tree mode mounts 1,369 BlockComponents synchronously on first paint. With virt, only 58 — even though scroll height correctly reflects all 1,365.

### 3. Virtualization does NOT fix scroll smoothness — per-block mount cost is the next bottleneck

Even with virt, scrolling causes batches of ~50 fresh BlockComponent mounts as the overscan boundary crosses. Each mount involves the ~10 `useHandle` subscriptions documented in the earlier analysis (`useInEditMode`, `useIsSelected`, `useInFocus`, breadcrumbs, properties, etc.). 50 mounts × ~10 subscriptions = 500 subscription setups per scroll burst, which can stall a frame.

This is the next thing to fix after this PR. Two clear levers:

- **Cut subscriptions per block.** Most rows don't need to listen to the panel-wide UIStateBlock; e.g. only the focused/selected blocks need real-time `useInFocus`/`useIsSelected`. Switching to a dispatcher that only notifies the affected block (keyed by id) cuts the bulk of the per-block hook count.
- **Smaller overscan + gentler eviction.** Today overscan = 8 each side (~16 rows). Bursty mount work could spread by either lowering overscan or scheduling mounts via `startTransition`.

### 4. Virtuoso wedges differently from tanstack — ditched

`react-virtuoso@4.18.6` received `data: [400 items]` and never called `itemContent` even with the React Compiler issue worked around. Couldn't isolate the cause in time; switched to `@tanstack/react-virtual@3.13.24` which works once the compiler issue is fixed. Virtuoso package can be removed.

## Files touched (the actual diff)

- [src/components/renderer/VirtualizedBlockTree.tsx](src/components/renderer/VirtualizedBlockTree.tsx) — new
- [src/components/renderer/PanelRenderer.tsx](src/components/renderer/PanelRenderer.tsx) — flag-gated mount of VBT
- [src/components/renderer/DefaultBlockRenderer.tsx](src/components/renderer/DefaultBlockRenderer.tsx) — `suppressChildren` short-circuit
- [src/components/BlockComponent.tsx](src/components/BlockComponent.tsx) — mount counter (dev-only)
- [src/App.tsx](src/App.tsx) — `window.__app` instrumentation hook (dev-only)
- [src/types.ts](src/types.ts) — `suppressChildren` field on `BlockContextType`
- `package.json` — `+@tanstack/react-virtual`, `+react-virtuoso` (latter unused, removable)

## How to reproduce

1. Run dev server.
2. In console: paste [tmp/perf-spike/seed.js](tmp/perf-spike/seed.js) (or a smaller variant) to seed.
3. Capture mount stats with `window.__blockStats`.
4. Toggle: `localStorage.setItem('virt', '0')` then reload for tree-mode baseline; `localStorage.removeItem('virt')` then reload for virtualized.

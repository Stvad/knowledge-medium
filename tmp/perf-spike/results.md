# Perf spike trial results

## Environment

- Vite dev server, React 19.2, React Compiler enabled (CRITICAL — see findings)
- React StrictMode active in dev → every BlockComponent mounts twice; `mounts` numbers are 2× the real mount-count, `live` is the real count.
- Synthetic data seeded into the live PowerSync repo via `repo.mutate.insertChildren`.
- Mount counter: `useEffect` in [BlockComponent](src/components/BlockComponent.tsx).

## Trials

### Initial-render mounts (after page load + 1.5 s stability window)

| Shape          | Total blocks | Mode  | Live BlockComponents | DOM `.tm-block` | scrollHeight |
|----------------|--------------|-------|----------------------|-----------------|--------------|
| small (d2 b6)  | 43           | tree  | 47                   | 43              | 1227 px (fits viewport) |
| small          | 43           | virt  | 47                   | 43              | 1290 px (fits viewport) |
| medium (d3 b7) | 400          | tree  | **404**              | 400             | 10,911 px |
| medium         | 400          | virt  | **57**               | 53              | 22,254 px |
| large-deep (d5 b4) | 1,365    | tree  | **1,369**            | 1,365           | 37,147 px |
| large-deep     | 1,365        | virt  | **58**               | 54              | 80,118 px |

**Mount reduction:** medium = **7×**, large-deep = **24×**. Virt mounts the visible window + overscan only — flat at ~50 BlockComponents regardless of total tree size.

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

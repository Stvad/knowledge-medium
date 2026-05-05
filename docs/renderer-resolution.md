# Renderer resolution

## Status

Proposed. Companion to [docs/type-system.md](docs/type-system.md), which explicitly defers renderer-resolution metadata for types ([§4b](docs/type-system.md)) to this redesign so types don't grow `defaultRenderer` / `priority` fields against a model that's about to change.

## Why

The current model — one `blockRenderersFacet` ([src/extensions/core.ts](src/extensions/core.ts)) plus a `canRender` / `priority` predicate sort in [useRenderer](src/hooks/useRendererRegistry.tsx:14) — works at today's scale (one plugin renderer, seven kernel renderers) but fails along eight axes that compound as the plugin surface grows:

1. **Uncoordinated priority numbers.** Kernel ships with `TopLevel=20` ([TopLevelRenderer.tsx:44](src/components/renderer/TopLevelRenderer.tsx:44)), `Layout=20` ([LayoutRenderer.tsx:152](src/components/renderer/LayoutRenderer.tsx:152)), `Breadcrumb=10` ([BreadcrumbRenderer.tsx:15](src/components/renderer/BreadcrumbRenderer.tsx:15)), `Panel=5` ([PanelRenderer.tsx:82](src/components/renderer/PanelRenderer.tsx:82)), `CodeMirrorExtension=5` ([CodeMirrorExtensionBlockRenderer.tsx:81](src/components/renderer/CodeMirrorExtensionBlockRenderer.tsx:81)), `MissingData=1` ([MissingDataRenderer.tsx:6](src/components/renderer/MissingDataRenderer.tsx:6)); the only plugin renderer in the codebase, `VideoPlayer=5` ([VideoPlayerRenderer.tsx:182](src/plugins/video-player/VideoPlayerRenderer.tsx:182)), collides with two kernel entries. There's no convention for what `5` means; collisions resolve by `Array.sort` stability over `Object.values(registry)`, which is registry-insertion order. New plugins guess.

2. **Three orthogonal decisions flattened onto one scalar.** Every dispatch entry competes on the same `priority` axis even though there are three independent concerns:
   - **Frame** — set by the *parent* via context: `TopLevelRenderer.canRender` reads `context.topLevel && !context.panelId`, `LayoutRenderer.canRender` reads `!context.topLevel && !context.panelId`, `PanelRenderer.canRender` reads `context.topLevel && context.panelId`, `BreadcrumbRenderer.canRender` reads `context.isBreadcrumb`. The parent has already implicitly decided which frame to render — see [LayoutRenderer.tsx:139](src/components/renderer/LayoutRenderer.tsx:139) wrapping in `NestedBlockContextProvider overrides={{topLevel: true, panelId: panel.id}}`, [TopLevelRenderer.tsx:12](src/components/renderer/TopLevelRenderer.tsx:12)'s `CONTEXT_OVERRIDE = {topLevel: false}` — but the renderer still has to win a tournament against every body renderer on the way down.
   - **Body** — set by the block: extension-typed block, video URL, code, plain markdown.
   - **Missing-data fallback** — `block.peek()` returned undefined.
   These should be independent dispatches with independent override chains. They aren't.

3. **Predicate metadata bolted onto the React component.** `BlockRenderer extends FunctionComponent` plus optional `canRender` / `priority` static fields ([src/types.ts:64](src/types.ts:64)). This conflates "this is a React component" with "this is a dispatch entry"; you can't introspect dispatch metadata without importing the component, and decoration patterns (e.g. wrapping a renderer with logging) lose the static fields silently.

4. **No explainability.** When the wrong renderer wins, `useRenderer` doesn't surface why. Was it `rendererProp`? Did `MissingDataRenderer.canRender` fire because `block.peek()` was momentarily undefined? Did two predicates both return true and one tie-break to the other by sort stability? You read the source and guess.

5. **`registry.default` is a magic-string fallback.** [useRendererRegistry.tsx:42](src/hooks/useRendererRegistry.tsx:42) returns `firstPriority ?? registry.default`. The default is just whatever contribution happens to register `id: 'default'` ([defaultRenderers.tsx:15](src/extensions/defaultRenderers.tsx:15)). It's a structural bookend dressed as a normal entry.

6. **`rendererProp` silently no-ops on a misspelled id.** Per [docs/follow-ups.md](docs/follow-ups.md) ("rendererProp silently no-ops on a misspelled renderer id"): when `rendererKey` is set but absent from the registry — typo, plugin not loaded, renderer renamed — [useRendererRegistry.tsx:26](src/hooks/useRendererRegistry.tsx:26) falls through to predicate dispatch with no signal. The user's explicit override is lost. Treated as in-scope here.

7. **`'use no memo'` on `useRenderer`.** [useRendererRegistry.tsx:15](src/hooks/useRendererRegistry.tsx:15) disables React Compiler memoization with a `// cludge` comment because the registry value flowing through a dynamic predicate sort is a moving target the compiler can't reason about. The structural fix is to make the dispatch deterministic per stable input, not to opt out of memoization.

8. **No multi-view path.** A block having multiple simultaneous presentations (one block; rendered as a card in a kanban *and* as a row in a table *and* as the focused detail pane — Embark-style, https://www.inkandswitch.com/embark/) is a future the current model can't grow into without a rewrite. Single-winner predicate dispatch is structurally one-presentation-per-mount.

## Goals / Non-goals

**Goals.**

- Replace the global priority tournament with a structurally divided dispatch where frame, body, and missing-data are independent decisions with independent override chains.
- Preserve **late binding + plugin override** as a load-bearing capability. A plugin must still be able to register an alternative breadcrumb / top-level / panel / layout renderer and own that frame globally; a plugin must still be able to register a body renderer for a content shape (`ReactPlayer.canPlay`-style) or a type id (`block.hasType('todo')`-style). Mounting frames as direct components (`<TopLevelBlock>`, `<BreadcrumbBlock>`) was rejected on a previous design pass because it kills override; staying late-bound is the constraint.
- Separate dispatch metadata from React component identity. `BlockRenderer` becomes pure `FunctionComponent<BlockRendererProps>`; `canRender` / `priority` static fields are removed.
- Surface a structured *reason* for every resolution so "why did this renderer win?" is answerable without reading source.
- Fix the misspelled-`rendererProp` silent fall-through (item #6) as a deliberate behavior, not a side effect.
- Restore React Compiler memoizability of `useRenderer` by making the dispatch deterministic on a stable structural input.
- Be compatible with the type-system v1 split — type contributions register body renderers into a slot, not into a `defaultRenderer` field on `TypeContribution` ([docs/type-system.md §4b](docs/type-system.md)).
- Leave room for multi-view (Embark) without designing it now.

**Non-goals.**

- Implementing multi-view. Sketched in §8; deferred to a follow-on doc.
- Touching `blockLayoutFacet` / `blockContentDecoratorsFacet` / `blockHeaderFacet` / `blockClickHandlersFacet` / `blockChildrenFooterFacet` / `blockContentSurfacePropsFacet` ([src/extensions/blockInteraction.ts](src/extensions/blockInteraction.ts)). Those already cleanly stack and aren't part of the dispatch problem; the type-system doc relies on them for additive UI ([docs/type-system.md §4a](docs/type-system.md)) and this redesign keeps them untouched.
- Building a dev-mode UI. The reason chain shape is specified; the overlay is sketched only.
- Designing a per-slot caching scheme beyond what naturally falls out of stable-input memoization. If profiling shows a hot spot, optimize then.

## Slot model

Replace the flat priority tournament with a fixed set of **named slots**. Each slot has its own override chain. There is no global numeric priority, anywhere.

### Slot families

```
frame:topLevel       // outer page chrome: header + container
frame:layout         // multi-panel arrangement
frame:panel          // one panel inside layout
frame:breadcrumb     // inline preview for parent chains and link decoration
frame:nested         // ordinary in-tree block (the implicit case today)

body:default         // framework-owned bookend
body:missingData     // framework-owned bookend
body:byType          // ordered chain, walked over block.typesProp
body:byContent       // ordered chain of content-shape predicates
```

### Override semantics

- A slot is **single-winner** at resolution time. Last contribution wins by default — same convention as `propertySchemasFacet`, `typesFacet`, and `blockLayoutFacet`'s last-contribution semantics ([src/extensions/blockInteraction.ts](src/extensions/blockInteraction.ts)).
- For `frame:*` and `body:default` / `body:missingData`, the slot key alone identifies the contribution; the kernel's contribution lands first, plugins land later, last-wins gives plugins ownership without numeric jockeying.
- For `body:byType` and `body:byContent`, the contributions form an **ordered chain** keyed by *type id* (for `byType`) or *predicate id* (for `byContent`). Within a single key, last-wins again. Across keys, walk order is contribution order (and for `byType`, also bounded by walk order over the block's `typesProp` — see §5).
- `before` / `after` ordering hints are available for fine control but should be rare; if you reach for them, registration order in the extension array is usually a cleaner answer.

### Registration shape

Renderer components stay pure. Dispatch metadata is a separate value contributed via a new facet:

```ts
// src/extensions/rendererSlots.ts (new)
export type RendererSlot =
  | 'frame:topLevel'
  | 'frame:layout'
  | 'frame:panel'
  | 'frame:breadcrumb'
  | 'frame:nested'
  | 'body:default'
  | 'body:missingData'
  | 'body:byType'
  | 'body:byContent'

export interface RendererSlotContribution {
  slot: RendererSlot
  /** For `body:byType`: the type id this contribution claims.
   *  For `body:byContent`: a stable id identifying the predicate
   *  (used in reason chains and for override-chain keying).
   *  Omitted for the singular slots. */
  key?: string
  renderer: BlockRenderer
  /** Predicate, used only by `body:byContent`. Receives the same
   *  resolve context the slot system uses (§9). */
  match?: (ctx: RendererResolveContext) => boolean
  /** Ordering hints; usually unnecessary. */
  before?: string
  after?: string
}

export const rendererSlotsFacet = defineFacet<RendererSlotContribution, RendererSlotIndex>({
  id: 'core.renderer-slots',
  combine: buildSlotIndex,
  empty: () => emptySlotIndex(),
  validate: isRendererSlotContribution,
})
```

`BlockRenderer` ([src/types.ts:64](src/types.ts:64)) drops its static-field shape:

```ts
export type BlockRenderer = FunctionComponent<BlockRendererProps>
```

The existing `blockRenderersFacet` + `RendererContribution` ([src/extensions/core.ts](src/extensions/core.ts)) survives unchanged for one reason only: `rendererProp` is a per-block string id, and the registry-by-id lookup is its natural home. See §6.

### Framework-owned bookends

`body:default` and `body:missingData` are *framework-owned* slots: the kernel's contribution registers there, but conceptually they're the structural fallbacks the resolver hits when no other body slot matched. A plugin overriding `body:default` is replacing the entire baseline body renderer for the workspace, which is a real and rare thing (a custom outliner shell, plain-outliner already replaces big pieces); a plugin overriding `body:missingData` is replacing the loading placeholder.

These are slots, not magic strings: there's no `registry.default` lookup — `body:default` falls out of normal slot resolution.

## Frame slots

Frame is selected by the **parent**, which already knows. The mount site says "render this block in `frame:topLevel`" and the slot's override chain decides which component wins.

### Selection at the mount site

[BlockComponent](src/components/BlockComponent.tsx) today consults `useRenderer` with the implicit context. After this redesign, mount sites that want a non-default frame pass it explicitly:

```tsx
// src/components/BlockComponent.tsx
export interface BlockComponentProps {
  blockId: string
  /** Frame the parent wants this block rendered in. Defaults to
   *  'frame:nested' — the in-tree case. */
  frame?: FrameSlot
}

export function BlockComponent({blockId, frame = 'frame:nested'}: BlockComponentProps) {
  const repo = useRepo()
  const block = repo.block(blockId)
  const context = useBlockContext()
  const Renderer = useRenderer({block, context, frame})
  return (
    <ErrorBoundary FallbackComponent={FallbackComponent}>
      <Suspense fallback={<SuspenseFallback/>}>
        <Renderer block={block} context={context}/>
      </Suspense>
    </ErrorBoundary>
  )
}
```

`frame === 'frame:nested'` is the body-resolution case (§5); every other value short-circuits straight to that frame's slot.

The four current frame triggers translate cleanly:

- The app shell mounts the top-level block as `<BlockComponent blockId={topLevelId} frame="frame:topLevel"/>`. (The current trigger is `context.topLevel && !context.panelId` — a piece of state the *parent* sets in [TopLevelRenderer.tsx:12](src/components/renderer/TopLevelRenderer.tsx:12) and [LayoutRenderer.tsx:139](src/components/renderer/LayoutRenderer.tsx:139). Replace the context flag with the explicit prop at the call site that's already deciding.)
- [TopLevelRenderer](src/components/renderer/TopLevelRenderer.tsx:36) mounts its inner block as `<BlockComponent blockId={block.id} frame="frame:layout"/>`.
- [LayoutRenderer](src/components/renderer/LayoutRenderer.tsx:143) mounts each panel as `<BlockComponent blockId={panel.id} frame="frame:panel"/>`.
- [PanelRenderer](src/components/renderer/PanelRenderer.tsx:74) mounts its zoomed block as `<BlockComponent blockId={topLevelBlockId} frame="frame:nested"/>` — the panel's *body* is just a normal block.
- [BreadcrumbList](src/components/BreadcrumbList.tsx) (and any other breadcrumb-like consumer) mounts its preview entries as `<BlockComponent blockId={parent.id} frame="frame:breadcrumb"/>`. The `BREADCRUMB_OVERRIDES = {...NESTED_OVERRIDES, isBreadcrumb: true}` pattern in [BacklinkEntry.tsx:13](src/plugins/backlinks/BacklinkEntry.tsx:13) becomes a `frame="frame:breadcrumb"` prop.

`isTopLevel`, `isBreadcrumb`, `panelId`, `topLevel` flags on `BlockContextType` ([src/types.ts:79](src/types.ts:79)) all stay — they're read by other facets ([defaultRenderers.tsx:34](src/extensions/defaultRenderers.tsx:34) gates the breadcrumb header on `ctx.isTopLevel`, [grouped-backlinks/index.ts](src/plugins/grouped-backlinks/index.ts) and [backlinks/index.ts](src/plugins/backlinks/index.ts) gate on `isTopLevel`) — but they no longer drive renderer dispatch. The `frame` prop drives that explicitly.

### What plugins can override

A plugin owns a frame globally by registering into that slot:

```ts
// In a plugin's AppExtension array
rendererSlotsFacet.of(
  {slot: 'frame:breadcrumb', renderer: FancyBreadcrumbRenderer},
  {source: 'fancy-breadcrumbs'},
)
```

Last-wins: the kernel registers first ([defaultRenderers.tsx](src/extensions/defaultRenderers.tsx)), the plugin registers later, the plugin wins. No numeric guessing.

Two plugins both registering `frame:breadcrumb` is the same situation as today's two `priority=10` clashes, except the resolution is deterministic by extension load order rather than by `Array.sort` stability over `Object.values(registry)`. This matches every other facet in the codebase.

## Body slots

When `frame === 'frame:nested'`, the resolver picks a body. Resolution order:

```
1. block.peek() === undefined          → body:missingData      (framework-owned)
2. rendererProp set                    → registry[rendererKey] (see §6)
3. body:byType chain over typesProp    → first match wins
4. body:byContent chain                → first match.match returning true wins
5.                                     → body:default          (framework-owned)
```

Each step short-circuits. Each step that fires emits a *reason* fragment (§7).

### `body:byType`

This is the integration point with [docs/type-system.md](docs/type-system.md). Type contributions don't grow `defaultRenderer` / `priority` fields — instead, a type that wants to own the entire block presentation registers into `body:byType`:

```ts
// In the video-player plugin (after migration; see §9)
rendererSlotsFacet.of(
  {slot: 'body:byType', key: 'video', renderer: VideoPlayerRenderer},
  {source: 'video-player'},
)
```

Resolution walks the block's `typesProp` array ([docs/type-system.md §2](docs/type-system.md)) in order; the first type id with a registered `body:byType` contribution wins. This means if a block has `types = ['todo', 'video']` and both register a body, `'todo'` wins because it's listed first — the type system's "earlier types take precedence" convention applies here naturally.

For the kernel's existing extension type, the `CodeMirrorExtensionBlockRenderer` registration becomes:

```ts
rendererSlotsFacet.of(
  {slot: 'body:byType', key: 'extension', renderer: CodeMirrorExtensionBlockRenderer},
  {source: 'kernel'},
)
```

This replaces the current `block.peek()?.properties.type === 'extension'` predicate ([CodeMirrorExtensionBlockRenderer.tsx:79](src/components/renderer/CodeMirrorExtensionBlockRenderer.tsx:79)) — once the type-system v1 multi-type migration lands, the type id is read from `typesProp` instead.

### `body:byContent`

The existing content-shape predicate path, scoped to body selection. The video player's `ReactPlayer.canPlay` test is the canonical example:

```ts
rendererSlotsFacet.of(
  {
    slot: 'body:byContent',
    key: 'video:react-player',
    renderer: VideoPlayerRenderer,
    match: ({block}) => {
      const data = block.peek()
      return !!(data && ReactPlayer.canPlay?.(data.content))
    },
  },
  {source: 'video-player'},
)
```

(In practice the video plugin would probably register against `body:byType` once it stamps `'video'` on imported video blocks; `body:byContent` is the path for renderers that want to dispatch on content shape with no type metadata — e.g. a "render any URL as a link card" plugin that doesn't require the user to tag blocks first.)

`body:byContent` has well-defined ordering: contributions are walked in registration order, and the first `match()` returning true wins. No priority numbers; if two content predicates clash, the later registration wins (override the earlier one) by registering with the same `key`, or sit alongside it with a different `key` and depend on registration order. Reason chains (§7) make any clash visible.

### `body:default`

Falls out of slot resolution as a real slot. The kernel registers `DefaultBlockRenderer` ([src/components/renderer/DefaultBlockRenderer.tsx](src/components/renderer/DefaultBlockRenderer.tsx)) into it:

```ts
rendererSlotsFacet.of(
  {slot: 'body:default', renderer: DefaultBlockRenderer},
  {source: 'kernel'},
)
```

A plugin replacing this is replacing the workspace's baseline body renderer — rare, intentional. There's no `registry.default` magic-string lookup; `body:default` is just a slot.

### `body:missingData`

Same pattern. The kernel registers `MissingDataRenderer` ([src/components/renderer/MissingDataRenderer.tsx](src/components/renderer/MissingDataRenderer.tsx)) into `body:missingData`. The resolver hits this slot whenever `block.peek() === undefined`, before any other body-slot consideration.

## `rendererProp` override

`rendererProp` ([src/data/properties.ts:113](src/data/properties.ts:113)) stays exactly as today — a per-block `string | undefined` naming a renderer id. It belongs at step 2 in the body-resolution order: after the missing-data check (a renderer can't render `undefined` content) and before any predicate slot.

The lookup uses the existing `blockRenderersFacet` ([src/extensions/core.ts](src/extensions/core.ts)) — that facet's id-keyed registry is exactly what `rendererProp` needs and there's no reason to duplicate it under the new slot facet. The two facets coexist:

- `rendererSlotsFacet` — frame and body dispatch by slot (§3)
- `blockRenderersFacet` — id-keyed registry for `rendererProp` lookup, plus the alias surface plugins like [exampleExtensions.ts](src/extensions/exampleExtensions.ts) already use to expose named renderers users can switch a block to.

A plugin that wants to expose a renderer for both type-driven dispatch *and* explicit `rendererProp` selection contributes to both facets — the kernel does this for `CodeMirrorExtensionBlockRenderer` (registered under `id: 'extension'` for `rendererProp` and into `body:byType[extension]` for type dispatch). This is cheap; both contributions live in the same extension array.

### Misspelled / unknown id

Per [follow-up #6](docs/follow-ups.md): when `rendererProp` is set but the id isn't in the registry — typo, plugin not loaded, renderer renamed — today's [useRendererRegistry.tsx:26](src/hooks/useRendererRegistry.tsx:26) silently falls through. The redesign makes this explicit: `console.warn` with the unknown id and the available ids, then fall through to the slot-based resolution. The reason chain records `rendererProp=<id>: not registered, falling through` so the misbehavior is visible in the dev overlay too.

```ts
if (rendererKey) {
  const registered = registry[rendererKey]
  if (registered) {
    return {renderer: registered, reason: [`rendererProp=${rendererKey} (block-set)`]}
  }
  console.warn(
    `[useRenderer] block ${block.id} has rendererProp=${JSON.stringify(rendererKey)} ` +
    `but no renderer is registered with that id. Available ids: ${Object.keys(registry).sort().join(', ')}.`,
  )
  // fall through; reason chain records the failed lookup
}
```

A future refinement could surface this in-product via a "renderer not found" sentinel renderer; that's UX work, not core resolution work, and is left for a follow-up.

## Explainability

Every resolution produces a structured *reason chain* describing what happened. The chain is the audit trail and the substrate for the dev-mode overlay.

### Shape

```ts
export interface RendererResolution {
  renderer: BlockRenderer
  reason: readonly RendererReasonStep[]
}

export type RendererReasonStep =
  | {kind: 'frame'; slot: FrameSlot; source: string}
  | {kind: 'rendererProp'; key: string; status: 'matched' | 'missing'}
  | {kind: 'missing-data'; source: string}
  | {kind: 'by-type'; typeId: string; source: string}
  | {kind: 'by-content'; key: string; source: string}
  | {kind: 'default'; source: string}
```

Each step carries the slot it represents and the `source` recorded on the contribution (the `{source: '…'}` arg to `facet.of`). Steps that *failed* to match still appear, so the chain reads as "tried X, didn't match because Y; tried Z, matched." For body resolution this is at most a handful of entries:

```
[
  {kind: 'rendererProp', key: 'code', status: 'missing'},  // typo'd, fell through
  {kind: 'by-type', typeId: 'video', source: 'video-player'},  // matched, won
]
```

For frame resolution the chain is one entry — the parent passed `frame: 'frame:breadcrumb'`, the slot resolved, end of story.

### Hook return shape

`useRenderer` returns the renderer component (compatible with current callers) and exposes the reason chain as a separate readable. To stay React-Compiler-friendly the hook returns a stable resolution object whose identity changes only when the resolved renderer or its reason changes:

```ts
export const useRenderer = ({block, context, frame}: UseRendererArgs): RendererResolution => {
  // No 'use no memo' — the resolution depends on:
  //   1. the slot index from runtime.read(rendererSlotsFacet) (cached per runtime)
  //   2. the registry from runtime.read(blockRenderersFacet)  (cached per runtime)
  //   3. block.peek()                                          (subscribed via useData)
  //   4. block.peekProperty(rendererProp)                      (subscribed via usePropertyValue)
  //   5. frame                                                 (caller-stable)
  // Memoize on those.
}
```

The `'use no memo'` cludge ([useRendererRegistry.tsx:15](src/hooks/useRendererRegistry.tsx:15)) goes away because the inputs are now structural — the hook reads named subscriptions (`useData`, `usePropertyValue`, `useAppRuntime`) and produces a deterministic resolution. There's no dynamic predicate sort over `Object.values(registry)` for the compiler to choke on.

### Debug helper

A `__resolveRenderer(blockId)` helper exposed on `window` in dev builds returns the full resolution including the reason chain:

```ts
window.__resolveRenderer = (blockId: string) => {
  const block = repo.block(blockId)
  const result = resolveRenderer({
    block,
    context: {topLevel: false},
    frame: 'frame:nested',
    runtime: globalRuntime,
  })
  console.table(result.reason)
  return result
}
```

Useful directly from the console when debugging "wrong renderer" reports.

### Dev-mode overlay (sketch)

Not built in this design; the reason chain is what makes it cheap to add. Sketch: a hover-triggered badge on the block bullet (gated behind a dev flag) that reads the resolution off `useRenderer` and renders the reason chain as a tooltip. Implementation lives entirely in a `blockHeaderFacet` or `blockContentDecoratorsFacet` contribution gated on the dev flag — no kernel change needed.

## Multi-view leave-room

Sketched only; not built.

The slot model generalizes to multi-view by adding a `view:*` family. Frames stay single-winner (the parent picks one frame slot); body resolution becomes "frame chose `view=default`" as a special case of "frame chose a view." A future Embark-style mount might say:

```tsx
<BlockComponent blockId={id} frame="frame:nested" view="view:kanban-card"/>
<BlockComponent blockId={id} frame="frame:nested" view="view:table-row"/>
<BlockComponent blockId={id} frame="frame:nested" view="view:detail-pane"/>
```

…with three independent `view:*` slots resolved against the same block, all rendering simultaneously in different parts of the UI. Each view slot has its own override chain (last-wins), each can dispatch by-type / by-content within itself if it wants, each emits its own reason chain.

What this asks of the v1 design:

- The `frame` prop on `BlockComponent` is the primitive multi-view will use; it's already present.
- Body resolution (§5) is the special case where view is implicit-default; making it an explicit `view: 'view:default'` arg later is additive, not structural.
- `body:byType` and `body:byContent` are *body* slots in v1 because there's only one body. In a multi-view world they generalize to per-view: each view slot can ride its own type/content chains. The slot facet doesn't need to know that yet.
- Nothing in v1 freezes the single-winner assumption for body resolution into a place where multi-view would have to fight it — `body:byType` returning a single renderer is just what happens when the (implicit) view is `default`.

What v1 doesn't do: design how mount points discover which views to display, how views interact with the type system's per-type "supported views" question, how view selection persists (UI state vs block metadata), whether there's a `view:auto` sentinel, etc. Those are the multi-view design's job and they don't bind v1 if v1 keeps the slot decomposition clean.

## Migration plan

Concrete sequencing. Each step is one PR-shaped change.

### 1. Introduce slot facet and resolver, kernel-only

- Add `src/extensions/rendererSlots.ts` defining `RendererSlot`, `RendererSlotContribution`, `rendererSlotsFacet`, the slot-index `combine` builder, and `resolveRenderer({block, context, frame, runtime})` which produces `RendererResolution`.
- Add a `frame?: FrameSlot` prop to [BlockComponent](src/components/BlockComponent.tsx); thread through to `useRenderer`.
- New `useRenderer` reads both `blockRenderersFacet` (for `rendererProp`) and `rendererSlotsFacet` (for everything else). Old `canRender` / `priority` static fields keep working as a transitional fall-through during this step (predicate sort runs only over contributions that still have them; new slot contributions don't).

### 2. Rewrite kernel renderer contributions

[src/extensions/defaultRenderers.tsx](src/extensions/defaultRenderers.tsx) becomes:

```ts
import { Breadcrumbs } from '@/components/Breadcrumbs.tsx'
import { BreadcrumbRenderer } from '@/components/renderer/BreadcrumbRenderer.tsx'
import { CodeMirrorExtensionBlockRenderer } from '@/components/renderer/CodeMirrorExtensionBlockRenderer.tsx'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.tsx'
import { LayoutRenderer } from '@/components/renderer/LayoutRenderer.tsx'
import { MissingDataRenderer } from '@/components/renderer/MissingDataRenderer.tsx'
import { PanelRenderer } from '@/components/renderer/PanelRenderer.tsx'
import { TopLevelRenderer } from '@/components/renderer/TopLevelRenderer.tsx'
import { blockHeaderFacet } from '@/extensions/blockInteraction.ts'
import { blockRenderersFacet } from '@/extensions/core.ts'
import { rendererSlotsFacet } from '@/extensions/rendererSlots.ts'
import { markdownExtensionsFacet } from '@/markdown/extensions.ts'
import { gfmMarkdownExtension } from '@/markdown/defaultMarkdownExtension.ts'

const KERNEL = {source: 'kernel'}

export const defaultRenderersExtension = [
  markdownExtensionsFacet.of(gfmMarkdownExtension, KERNEL),

  // Frame slots — last-wins, kernel registers first.
  rendererSlotsFacet.of({slot: 'frame:topLevel', renderer: TopLevelRenderer}, KERNEL),
  rendererSlotsFacet.of({slot: 'frame:layout', renderer: LayoutRenderer}, KERNEL),
  rendererSlotsFacet.of({slot: 'frame:panel', renderer: PanelRenderer}, KERNEL),
  rendererSlotsFacet.of({slot: 'frame:breadcrumb', renderer: BreadcrumbRenderer}, KERNEL),

  // Body bookends.
  rendererSlotsFacet.of({slot: 'body:default', renderer: DefaultBlockRenderer}, KERNEL),
  rendererSlotsFacet.of({slot: 'body:missingData', renderer: MissingDataRenderer}, KERNEL),

  // Body by type — one entry today, more once type-system v1 lands.
  rendererSlotsFacet.of(
    {slot: 'body:byType', key: 'extension', renderer: CodeMirrorExtensionBlockRenderer},
    KERNEL,
  ),

  // rendererProp registry — id-keyed, for explicit per-block overrides.
  // Same renderers, addressable by id. (Aliases stay as today.)
  blockRenderersFacet.of({id: 'default', renderer: DefaultBlockRenderer}, KERNEL),
  blockRenderersFacet.of({id: 'extension', renderer: CodeMirrorExtensionBlockRenderer}, KERNEL),

  blockHeaderFacet.of(
    ctx => ctx.isTopLevel ? Breadcrumbs : null,
    KERNEL,
  ),
]
```

Note what's *not* registered into `blockRenderersFacet`: `TopLevelRenderer`, `LayoutRenderer`, `PanelRenderer`, `BreadcrumbRenderer`, `MissingDataRenderer`. These are slot-driven and never the target of `rendererProp` — keeping them out of the id registry prevents misuse.

Drop the static fields from each renderer file:

- `TopLevelRenderer.canRender` / `.priority` removed ([TopLevelRenderer.tsx:43](src/components/renderer/TopLevelRenderer.tsx:43)).
- `LayoutRenderer.canRender` / `.priority` removed ([LayoutRenderer.tsx:150](src/components/renderer/LayoutRenderer.tsx:150)).
- `PanelRenderer.canRender` / `.priority` removed ([PanelRenderer.tsx:81](src/components/renderer/PanelRenderer.tsx:81)).
- `BreadcrumbRenderer.canRender` / `.priority` removed ([BreadcrumbRenderer.tsx:14](src/components/renderer/BreadcrumbRenderer.tsx:14)).
- `MissingDataRenderer.canRender` / `.priority` removed ([MissingDataRenderer.tsx:5](src/components/renderer/MissingDataRenderer.tsx:5)).
- `CodeMirrorExtensionBlockRenderer.canRender` / `.priority` removed ([CodeMirrorExtensionBlockRenderer.tsx:79](src/components/renderer/CodeMirrorExtensionBlockRenderer.tsx:79)).

### 3. Migrate frame mount sites to pass `frame`

- App shell's top-level mount: `<BlockComponent frame="frame:topLevel"/>`.
- [TopLevelRenderer.tsx:36](src/components/renderer/TopLevelRenderer.tsx:36) — wrap the inner `BlockComponent` with `frame="frame:layout"`. The `NestedBlockContextProvider overrides={CONTEXT_OVERRIDE}` ([TopLevelRenderer.tsx:35](src/components/renderer/TopLevelRenderer.tsx:35)) stays for non-resolution context (e.g. `topLevel: false` is read by `blockHeaderFacet` gates), but no longer drives renderer dispatch.
- [LayoutRenderer.tsx:143](src/components/renderer/LayoutRenderer.tsx:143) — `<BlockComponent blockId={panel.id} frame="frame:panel"/>`. Same treatment of the `NestedBlockContextProvider` overrides.
- [PanelRenderer.tsx:74](src/components/renderer/PanelRenderer.tsx:74) — `<BlockComponent blockId={topLevelBlockId} frame="frame:nested"/>`.
- [Breadcrumbs.tsx](src/components/Breadcrumbs.tsx) and [BacklinkEntry.tsx:13](src/plugins/backlinks/BacklinkEntry.tsx:13) — drop the `isBreadcrumb: true` context override; instead pass `frame="frame:breadcrumb"` to whichever `BlockComponent` mount renders the breadcrumb preview. (The flag itself can stay on `BlockContextType` if other facets read it.)

### 4. Migrate the video-player plugin

[src/plugins/video-player/VideoPlayerRenderer.tsx](src/plugins/video-player/VideoPlayerRenderer.tsx:176) — drop `VideoPlayerRenderer.canRender` and `VideoPlayerRenderer.priority`.

[src/plugins/video-player/index.ts](src/plugins/video-player/index.ts) becomes:

```ts
rendererSlotsFacet.of(
  {
    slot: 'body:byContent',
    key: 'video:react-player',
    renderer: VideoPlayerRenderer,
    match: ({block}) => {
      const data = block.peek()
      return !!(data && ReactPlayer.canPlay?.(data.content))
    },
  },
  {source: 'video-player'},
),
// Optional: also addressable via rendererProp = 'videoPlayer'
blockRenderersFacet.of(
  {id: 'videoPlayer', renderer: VideoPlayerRenderer},
  {source: 'video-player'},
),
```

If/when imported videos are stamped with `'video'` in `typesProp` ([docs/type-system.md](docs/type-system.md)), the `body:byContent` registration above can be replaced with `body:byType[video]` — same renderer, more deterministic dispatch.

### 5. Update example extensions and exported API surface

- [src/extensions/exampleExtensions.ts](src/extensions/exampleExtensions.ts) keeps using `blockRenderersFacet` for the `rendererProp`-addressable case. Comments updated to clarify that contributing only to `blockRenderersFacet` registers the renderer for `rendererProp` lookup but not for predicate dispatch — to participate in dispatch, also contribute to `rendererSlotsFacet`.
- Whatever `@/extensions/api.js` re-exports for example/extension authors (used in the inline source strings) gains `rendererSlotsFacet`.

### 6. Tighten `BlockRenderer`, drop the transitional fall-through

Once steps 1–5 land:

- [src/types.ts:64](src/types.ts:64) — `BlockRenderer` becomes `FunctionComponent<BlockRendererProps>` with no static fields:
  ```ts
  export type BlockRenderer = FunctionComponent<BlockRendererProps>
  ```
- The transitional predicate-sort path in `useRenderer` from step 1 is removed.
- Drop `RendererRegistry` if no other consumer needs it; otherwise leave it as the type of `runtime.read(blockRenderersFacet)`.

### 7. Drop `'use no memo'` and verify

- Remove `'use no memo'` from [useRendererRegistry.tsx:15](src/hooks/useRendererRegistry.tsx:15).
- The hook now reads stable subscriptions (`useData`, `usePropertyValue(rendererProp)`, `useAppRuntime`); React Compiler can memoize. Verify with the compiler's diagnostic mode that no warnings fire.
- Optional: profile a synthetic re-render storm to confirm `useRenderer` is no longer a hot spot.

### Change scope summary

| File | Change |
|---|---|
| [src/types.ts:64](src/types.ts:64) | `BlockRenderer` loses static fields |
| [src/hooks/useRendererRegistry.tsx](src/hooks/useRendererRegistry.tsx) | Rewritten around `resolveRenderer`; `'use no memo'` removed |
| [src/extensions/rendererSlots.ts](src/extensions/rendererSlots.ts) | New file |
| [src/extensions/core.ts](src/extensions/core.ts) | `blockRenderersFacet` unchanged; comment updated to scope it to `rendererProp` |
| [src/extensions/defaultRenderers.tsx](src/extensions/defaultRenderers.tsx) | Rewritten per step 2 |
| [src/components/BlockComponent.tsx](src/components/BlockComponent.tsx) | New `frame?` prop; thread through |
| [src/components/renderer/*.tsx](src/components/renderer) | Drop `canRender` / `priority` from each |
| [src/components/Breadcrumbs.tsx](src/components/Breadcrumbs.tsx), [src/plugins/backlinks/BacklinkEntry.tsx](src/plugins/backlinks/BacklinkEntry.tsx) | Pass `frame="frame:breadcrumb"` |
| [src/plugins/video-player/index.ts](src/plugins/video-player/index.ts), [VideoPlayerRenderer.tsx:176](src/plugins/video-player/VideoPlayerRenderer.tsx:176) | Migrated per step 4 |

No data migration. No persistence-format changes. No protocol changes.

## Compatibility with type-system v1

[docs/type-system.md §4b](docs/type-system.md) deliberately doesn't put `defaultRenderer` / `priority` fields on `TypeContribution`. The reasoning given there is that encoding renderer-resolution metadata on types would (a) duplicate the existing facet's job, (b) leak behavior into the membership layer, and (c) pre-commit to single-winner dispatch in a way that constrains multi-view futures.

This redesign is what justifies that. After this lands:

- A type that wants to own the entire body of its blocks contributes to `body:byType` keyed by its type id, alongside its `typesFacet` contribution. The contributions compose in the same `AppExtension` array; there's no special slot on `TypeContribution`.
- The kernel's existing `'extension'` type is exactly this pattern — `CodeMirrorExtensionBlockRenderer` is contributed to `body:byType[extension]`, and once type-system v1 ships, the kernel also contributes the matching `typesFacet` entry.
- Decorations, headers, click handlers — the common type-driven UI cases per [docs/type-system.md §4a](docs/type-system.md) — keep using the existing block-interaction facets ([src/extensions/blockInteraction.ts](src/extensions/blockInteraction.ts)) without going near renderer resolution. That split is preserved.

The type-system doc's "until then, register a renderer in `blockRenderersFacet` with a type-checking `canRender`, pick a priority that fits the existing landscape" guidance ([§4b last paragraph](docs/type-system.md)) is replaced by "register into `body:byType` keyed by your type id." The doc's §4 stays valid; only the closing paragraph needs an update once this lands.

## Follow-ups deferred from this redesign

- **Multi-view design.** §8 sketches the leave-room. Designing how mount points discover views, how view selection persists, how the type system declares "this type supports these views," and how the dev-mode overlay represents multi-view is its own doc, triggered when there's a real consumer.
- **Dev-mode overlay UX.** Reason chain shape is specified (§7); the overlay is a `blockHeaderFacet` / `blockContentDecoratorsFacet` contribution gated on a dev flag, designed when someone actually needs it to debug a real misroute.
- **Per-slot caching beyond stable-input memoization.** The redesign's structural shape lets React Compiler memoize naturally and lets `runtime.read(rendererSlotsFacet)` cache the slot index once per runtime. If profiling shows a hot spot — particularly in `body:byContent` chains where each entry's `match()` runs per resolution — add a per-block resolution cache keyed on `(block.id, block.peek()?.properties.types, rendererProp value)`. Don't pre-build it.
- **"Renderer not found" sentinel for misspelled `rendererProp`.** §6 surfaces the unknown-id case in `console.warn` and the reason chain. A user-visible sentinel renderer ("this block requested a renderer named `xyz` which isn't registered — pick one or remove the override") is a UX follow-up, not core resolution work.
- **Generalizing `before` / `after` ordering.** The slot facet supports them but the migration doesn't use them. If three-or-more body-by-content predicates need to interleave (e.g. a generic URL-card plugin and a YouTube-specific plugin where YouTube must run first), document the ordering convention then; pre-building the ergonomics before the third real case is unnecessary.
- **Removing the `BlockContextType` flags that no longer drive resolution.** `topLevel`, `panelId`, `isBreadcrumb` ([src/types.ts:79](src/types.ts:79)) survive because other facets read them ([defaultRenderers.tsx:34](src/extensions/defaultRenderers.tsx:34), [grouped-backlinks/index.ts](src/plugins/grouped-backlinks/index.ts), [backlinks/index.ts](src/plugins/backlinks/index.ts)). Once those facets either move off the flags or get explicit context shapes, the flags can be dropped — but that's an unrelated cleanup, not part of this redesign.

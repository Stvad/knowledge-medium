# `blockContentDecoratorsFacet` — design

## Problem

Today, two facets shape per-block rendering and neither lets multiple
extensions *layer decoration* on top of the same block:

- [`blockRenderersFacet`](src/extensions/core.ts) — exclusive selection. Only
  one renderer wins (property route, then `canRender` + `priority`).
- [`blockContentRendererFacet`](src/extensions/blockInteraction.ts:93) —
  last-truthy contribution wins (`combineLastContributionResult`).

The `emoji-react` example in
[exampleExtensions.ts:94](src/extensions/exampleExtensions.ts:94) wants to
*stack* a reactions row on top of whatever the block already renders
(markdown, video player, plain-outliner edit-mode CodeMirror, …). Today it
hijacks `blockRenderersFacet` with `priority: 1`, which means a video block
wins over reactions and a `renderer: hello-renderer` block hides reactions
entirely.

## Contract

```ts
// blockInteraction.ts (new sibling to blockContentRendererFacet)
export type BlockContentDecorator =
  (innerRenderer: BlockRenderer) => BlockRenderer

export type BlockContentDecoratorContribution =
  (context: BlockInteractionContext) =>
    BlockContentDecorator | null | undefined | false

export type BlockContentDecoratorResolver =
  (context: BlockInteractionContext, inner: BlockRenderer) => BlockRenderer

export const blockContentDecoratorsFacet = defineFacet<
  BlockContentDecoratorContribution,
  BlockContentDecoratorResolver
>({
  id: 'core.block-content-decorators',
  combine: contributions => (context, inner) => {
    let renderer = inner
    for (const contribution of contributions) {
      const decorator = contribution(context)
      if (decorator) renderer = decorator(renderer)
    }
    return renderer
  },
  empty: () => (_context, inner) => inner,
  validate: isFunction<BlockContentDecoratorContribution>,
})
```

A contribution is a function from context → optional decorator. A decorator
takes the inner `BlockRenderer` and returns a new `BlockRenderer` that
typically renders the inner one plus its own chrome.

## Integration

In [DefaultBlockRenderer.tsx:256–257](src/components/renderer/DefaultBlockRenderer.tsx:256),
after `ContentRenderer` is resolved (mode swap already applied via
`blockContentRendererFacet`), wrap once more:

```tsx
const resolveContentRenderer = runtime.read(blockContentRendererFacet)
const baseContentRenderer =
  resolveContentRenderer(blockInteractionContext) ?? DefaultContentRenderer

const decorate = runtime.read(blockContentDecoratorsFacet)
const ContentRenderer = useMemo(
  () => decorate(blockInteractionContext, baseContentRenderer),
  [decorate, blockInteractionContext, baseContentRenderer],
)
```

The render site at line 320 stays unchanged.

## Composition semantics

- **Order.** `FacetRuntime.read` ([facet.ts:115–117](src/extensions/facet.ts:115))
  already sorts contributions by `precedence` ascending, ties broken by
  registration order. Decorators apply in that order, so the *last*
  contribution wraps the outermost layer (its chrome appears furthest from
  the inner content). Document this contract; add a short note that lower
  precedence = closer to the inner content.
- **Per-block opt-out.** Returning `null | undefined | false` from a
  contribution skips it for that block. Reactions can return `null` when
  `block.properties['user:reactions']` is empty, avoiding wrapper noise.
- **Interaction with mode swap.** `blockContentRendererFacet` runs first, so
  in edit mode the inner is `CodeMirrorContentRenderer`
  ([plain-outliner/interactions.ts:11](src/plugins/plain-outliner/interactions.ts:11));
  the reactions row still shows above the editor.
- **Interaction with `blockRenderersFacet`.** Block-level renderers like
  `VideoPlayerRenderer` ([VideoPlayerRenderer.tsx:58](src/plugins/video-player/VideoPlayerRenderer.tsx:58))
  delegate to `DefaultBlockRenderer` with their own `ContentRenderer` prop.
  The decorator facet wraps that prop, so a video block also gets
  reactions. This is desired but worth calling out — see Open Questions.
- **Re-render stability.** Each render produces a fresh wrapped component
  identity, which would unmount/remount the inner tree. Mitigations:
  1. `useMemo` over `(decorate, baseContentRenderer, context)` in
     `DefaultBlockRenderer` (cheap, fixes the trivial case).
  2. Each decorator should also memoize its inner-renderer wrapper —
     analogous to plain-outliner returning the existing slot reference
     ([blockContentRendererFacet uses
     `getBlockContentRendererSlot`](src/extensions/blockInteraction.ts:87)
     to keep identity). Document this as a contract for decorator authors.

## Migration: `emoji-react`

**Before** ([exampleExtensions.ts:135–144](src/extensions/exampleExtensions.ts:135)):

```js
const ReactionsRenderer = (props) =>
  <DefaultBlockRenderer {...props} ContentRenderer={ReactionsContent} />
ReactionsRenderer.canRender = ({ block }) =>
  Array.isArray(block.dataSync()?.properties['user:reactions']?.value)
ReactionsRenderer.priority = () => 1

// …later in the array:
blockRenderersFacet.of({ id: 'reactions-row', renderer: ReactionsRenderer })
```

**After** — true layering, no priority race:

```js
import { blockContentDecoratorsFacet } from '@/extensions/api.js'

blockContentDecoratorsFacet.of((ctx) => {
  const reactions = ctx.block.dataSync()?.properties['user:reactions']?.value
  if (!Array.isArray(reactions) || reactions.length === 0) return null

  return (Inner) => {
    const Decorated = (props) => (
      <div>
        <Inner {...props} />
        <ReactionsRow reactions={reactions} />
      </div>
    )
    return Decorated
  }
})
```

Now `hello-renderer` + reactions, `video-player` + reactions, and edit mode
+ reactions all stack correctly.

## Open questions

1. **Author-driven decorator slot.** Should `DefaultBlockRenderer` expose a
   prop like `decorateContent={(inner) => …}` so block-renderer authors
   (video-player, hello-renderer) can layer their own decorators *inside*
   their renderer, independent of the facet? Probably yes — but out of
   scope here; the facet alone is enough to unblock `emoji-react`.
2. **Per-block opt-out by the chosen block renderer.** Should
   `VideoPlayerRenderer` be able to declare "no decorators apply to me"?
   The current proposal says no — decorators are a global concern. If we
   want it, the cleanest place is a flag on the renderer
   (`VideoPlayerRenderer.skipDecorators = true`) checked in
   `DefaultBlockRenderer` before applying `decorate`. Defer until a real
   conflict shows up.
3. **Children/properties decoration.** This facet only decorates the
   *content* slot. A separate `blockChromeDecoratorsFacet` could wrap the
   whole block (bullet + content + children). Defer.

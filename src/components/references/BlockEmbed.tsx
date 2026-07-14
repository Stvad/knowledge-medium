import { BlockComponent } from '@/components/BlockComponent'
import { RenderSurfaceProvider, useBlockContext } from '@/context/block.js'
import { useRepo } from '@/context/repo'
import { useBlockExists } from '@/hooks/block'
import { BlockRefAncestorsProvider } from './cycleGuard'
import { useBlockRefAncestors } from './useBlockRefAncestors'
import { embedRenderScopeId, outlineRenderScopeId } from '@/utils/renderScope.js'
import { EMPTY_RENDER_VISIBILITY_POLICY } from '@/utils/renderVisibility.js'

// `isReference: false` CLEARS an inherited reference flag: a reference renders
// its raw markdown content, which can itself contain a `!((id))` embed. Without
// clearing it, that nested embed would inherit `isReference` (context merges,
// never clears) and wrongly render via the reference layout — inline, no
// children, not editable — instead of as an embed. An embed is its own surface,
// never a reference.
const EMBED_CONTEXT_OVERRIDES = {isNestedSurface: true, isEmbedded: true, isReference: false}

export function BlockEmbed({
  blockId,
  sourceBlockId,
  occurrenceId,
}: {
  blockId: string
  sourceBlockId: string
  occurrenceId: string
}) {
  const repo = useRepo()
  const ancestors = useBlockRefAncestors()
  const blockContext = useBlockContext()
  const parentRenderScopeId = typeof blockContext.renderScopeId === 'string'
    ? blockContext.renderScopeId
    : outlineRenderScopeId(sourceBlockId)
  const renderScopeId = embedRenderScopeId(
    parentRenderScopeId,
    sourceBlockId,
    occurrenceId,
    blockId,
  )
  const target = repo.block(blockId)
  const targetExists = useBlockExists(target)

  if (!targetExists) {
    return (
      <div className="blockembed blockembed--unresolved border border-dashed border-muted-foreground/40 rounded p-2 my-1 text-sm text-muted-foreground">
        Embedded block not loaded yet (({blockId.slice(0, 8)}…))
      </div>
    )
  }

  if (ancestors.has(blockId)) {
    return (
      <div className="blockembed blockembed--cycle border border-dashed border-amber-500/60 rounded p-2 my-1 text-sm text-amber-700">
        ↻ Cycle detected — block (({blockId.slice(0, 8)}…)) already appears in the embed chain
      </div>
    )
  }

  // The embed already renders the target through the one block-rendering
  // pipeline (`BlockComponent` → the block's renderer → its layout). The box is
  // OUTER chrome around that fully-rendered block, not an alternative layout of
  // it — so unlike the reference (whose layout changes *what* renders: raw
  // content instead of the editable surface), the embed keeps a plain wrapper
  // here rather than a `blockLayoutFacet` contribution. Keeping it outside the
  // layout axis avoids coupling the box to the inner renderer and avoids
  // fighting per-block layouts (e.g. the video player) for the single-winner
  // layout slot. The bullet on each row inside is already navigable, so there's
  // no separate "source" link.
  return (
    <BlockRefAncestorsProvider ancestor={blockId}>
      <div className="blockembed border-l-2 border-muted pl-2 my-1 bg-muted/30 rounded-r">
        <RenderSurfaceProvider
          overrides={{
            ...EMBED_CONTEXT_OVERRIDES,
            renderScopeId,
            scopeRootId: blockId,
            renderVisibilityPolicy: EMPTY_RENDER_VISIBILITY_POLICY,
          }}
        >
          <BlockComponent blockId={blockId}/>
        </RenderSurfaceProvider>
      </div>
    </BlockRefAncestorsProvider>
  )
}

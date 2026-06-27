import { BlockComponent } from '@/components/BlockComponent'
import { NestedBlockContextProvider, useBlockContext } from '@/context/block.js'
import { useRepo } from '@/context/repo'
import { useBlockExists } from '@/hooks/block'
import { BlockRefAncestorsProvider } from './cycleGuard'
import { useBlockRefAncestors } from './useBlockRefAncestors'
import { embedRenderScopeId, outlineRenderScopeId } from '@/utils/renderScope.js'

const EMBED_CONTEXT_OVERRIDES = {isNestedSurface: true, isEmbedded: true}

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

  // The embed mounts the target through the one block-rendering pipeline; the
  // highlighted box chrome lives in the embed layout (gated on `isEmbedded` +
  // the embed root). The bullet on each row inside is already navigable, so
  // there's no separate "source" link.
  return (
    <BlockRefAncestorsProvider ancestor={blockId}>
      <NestedBlockContextProvider overrides={{...EMBED_CONTEXT_OVERRIDES, renderScopeId, scopeRootId: blockId}}>
        <BlockComponent blockId={blockId}/>
      </NestedBlockContextProvider>
    </BlockRefAncestorsProvider>
  )
}

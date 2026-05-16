import { BlockComponent } from '@/components/BlockComponent'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useRepo } from '@/context/repo'
import { useBlockExists } from '@/hooks/block'
import { BlockRefAncestorsProvider } from './cycleGuard'
import { useBlockRefAncestors } from './useBlockRefAncestors'

const EMBED_CONTEXT_OVERRIDES = {isNestedSurface: true, isEmbedded: true}

export function BlockEmbed({blockId}: {blockId: string}) {
  const repo = useRepo()
  const ancestors = useBlockRefAncestors()
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

  // Just the highlighted box around the rendered subtree — the bullet on
  // each row inside is already navigable, so no separate "source" link.
  return (
    <BlockRefAncestorsProvider ancestor={blockId}>
      <div className="blockembed border-l-2 border-muted pl-2 my-1 bg-muted/30 rounded-r">
        <NestedBlockContextProvider overrides={EMBED_CONTEXT_OVERRIDES}>
          <BlockComponent blockId={blockId}/>
        </NestedBlockContextProvider>
      </div>
    </BlockRefAncestorsProvider>
  )
}

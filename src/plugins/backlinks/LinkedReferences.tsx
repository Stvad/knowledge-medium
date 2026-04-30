import { useCallback, useMemo, useState } from 'react'
import { Block } from '@/data/internals/block'
import { BlockRendererProps } from '@/types.ts'
import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BreadcrumbList } from '@/components/BreadcrumbList.tsx'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useBacklinks, useParents } from '@/hooks/block.ts'
import { useRepo } from '@/context/repo.tsx'

const NESTED_OVERRIDES = {topLevel: false, isBacklink: true}
const BREADCRUMB_OVERRIDES = {...NESTED_OVERRIDES, isBreadcrumb: true}

interface BreadcrumbsProps {
  shownBlock: Block
  onSelect: (parent: Block) => void
}

// Roam-style: breadcrumbs are the chain ABOVE the currently-shown block.
// Click a segment to "unfurl" — promote it to the shown block. The
// breadcrumb chain truncates accordingly and the body re-renders the
// chosen parent's subtree (which still contains the original backlink as
// a descendant).
const BacklinkBreadcrumbs = ({shownBlock, onSelect}: BreadcrumbsProps) => {
  const repo = useRepo()
  const workspaceId = repo.activeWorkspaceId
  const parents = useParents(shownBlock)

  if (!workspaceId) return null

  return (
    <BreadcrumbList
      parents={parents}
      workspaceId={workspaceId}
      overrides={BREADCRUMB_OVERRIDES}
      onSelect={onSelect}
      className="flex items-center gap-1 text-xs text-muted-foreground/80 mb-1 flex-wrap"
      itemClassName="no-underline cursor-pointer truncate max-w-[24ch] hover:text-foreground"
      separatorClassName="mx-1 text-muted-foreground/40"
    />
  )
}

const BacklinkItem = ({block}: { block: Block }) => {
  const repo = useRepo()
  const [shownBlockId, setShownBlockId] = useState(block.id)
  const shownBlock = useMemo(() => repo.block(shownBlockId), [repo, shownBlockId])

  const handleSelect = useCallback((parent: Block) => {
    setShownBlockId(parent.id)
  }, [])

  return (
    <div className="border-l-2 border-muted pl-3 py-2">
      <BacklinkBreadcrumbs shownBlock={shownBlock} onSelect={handleSelect}/>
      <NestedBlockContextProvider overrides={NESTED_OVERRIDES}>
        <BlockComponent blockId={shownBlockId}/>
      </NestedBlockContextProvider>
    </div>
  )
}

export function LinkedReferences({block}: BlockRendererProps) {
  const backlinks = useBacklinks(block)
  const [open, setOpen] = useState(true)

  if (backlinks.length === 0) return null

  return (
    <div className="mt-8 pt-4 border-t border-border">
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <span className="text-base leading-none">{open ? '▾' : '▸'}</span>
        <span>Linked References</span>
        <span className="text-xs text-muted-foreground/70">{backlinks.length}</span>
      </button>

      {open && (
        <div className="mt-3 flex flex-col gap-3">
          {backlinks.map(backlinkBlock => (
            <BacklinkItem key={backlinkBlock.id} block={backlinkBlock}/>
          ))}
        </div>
      )}
    </div>
  )
}

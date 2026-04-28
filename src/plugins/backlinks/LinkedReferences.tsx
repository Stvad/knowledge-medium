import { useCallback, useEffect, useMemo, useState } from 'react'
import { Block } from '@/data/block.ts'
import { Repo } from '@/data/repo.ts'
import { BlockRendererProps } from '@/types.ts'
import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BreadcrumbList } from '@/components/BreadcrumbList.tsx'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useBacklinks } from '@/hooks/block.ts'
import { useRepo } from '@/context/repo.tsx'

const NESTED_OVERRIDES = {topLevel: false, isBacklink: true}
const BREADCRUMB_OVERRIDES = {...NESTED_OVERRIDES, isBreadcrumb: true}

// Walk parent chain from cached snapshots (synchronous). The blocks we
// render here are already loaded — backlinks query just hydrated them
// and unfurl moves to a parent whose chain we've also rendered. Returns
// what's currently in cache; missing links short-circuit the walk so we
// never render stale chains.
const computeParentsFromCache = (repo: Repo, blockId: string): Block[] => {
  const result: Block[] = []
  const seen = new Set<string>([blockId])
  let currentId: string | undefined = blockId
  while (currentId) {
    const data = repo.getCachedBlockData(currentId)
    if (!data?.parentId || seen.has(data.parentId)) break
    seen.add(data.parentId)
    result.unshift(repo.find(data.parentId))
    currentId = data.parentId
  }
  return result
}

// Returns the parent chain for a block reactively, without suspending.
// Initial render uses the cached chain (typically complete for blocks
// we've already rendered); an effect then asks the repo to load any
// missing ancestors and updates state when they arrive.
const useParents = (block: Block): Block[] => {
  const repo = useRepo()
  const blockId = block.id
  const [parents, setParents] = useState<Block[]>(() => computeParentsFromCache(repo, blockId))

  useEffect(() => {
    setParents(computeParentsFromCache(repo, blockId))

    let cancelled = false
    void block.parents().then(loaded => {
      if (cancelled) return
      const sameChain =
        loaded.length === parents.length &&
        loaded.every((p, i) => p.id === parents[i]?.id)
      if (!sameChain) setParents(loaded)
    })
    return () => {
      cancelled = true
    }
    // We intentionally do not depend on `parents` — re-running the
    // async load every time we set state would loop. The dep on blockId
    // is what should drive a re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, block, blockId])

  return parents
}

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
  const shownBlock = useMemo(() => repo.find(shownBlockId), [repo, shownBlockId])

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

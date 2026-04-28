import { MouseEvent, Suspense, use, useCallback, useMemo, useState } from 'react'
import { Block } from '@/data/block.ts'
import { BlockRendererProps } from '@/types.ts'
import { BlockComponent } from '@/components/BlockComponent.tsx'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useBacklinks } from '@/hooks/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { buildAppHash } from '@/utils/routing.ts'

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
  const parents = use(useMemo(() => shownBlock.parents(), [shownBlock.id]))

  if (parents.length === 0 || !workspaceId) return null

  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground/80 mb-1 flex-wrap">
      {parents.map((parent) => (
        <span key={parent.id} className="flex items-center min-w-0">
          <a
            href={buildAppHash(workspaceId, parent.id)}
            className="no-underline cursor-pointer truncate max-w-[24ch] hover:text-foreground"
            // Plain click unfurls inline; modified clicks (cmd/ctrl/shift,
            // middle/right) fall through to the href so the user can still
            // navigate or open in a panel the way the rest of the app's
            // links work. Stop propagation either way — without it, the
            // event bubbles to the surrounding block's click handler,
            // which preventDefaults and swallows the browser navigation.
            onClick={(event: MouseEvent) => {
              event.stopPropagation()
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
              if (event.button !== 0) return
              event.preventDefault()
              onSelect(parent)
            }}
          >
            <span className="inline [&>*]:inline [&>p]:m-0 [&>*]:whitespace-nowrap [&>*]:overflow-hidden [&>*]:text-ellipsis [&>*]:font-normal [&>*]:text-inherit text-muted-foreground/80">
              <NestedBlockContextProvider overrides={BREADCRUMB_OVERRIDES}>
                <BlockComponent blockId={parent.id}/>
              </NestedBlockContextProvider>
            </span>
          </a>
          <span className="mx-1 text-muted-foreground/40">›</span>
        </span>
      ))}
    </div>
  )
}

const BacklinkItem = ({block}: { block: Block }) => {
  const repo = useRepo()
  const [shownBlockId, setShownBlockId] = useState(block.id)
  const shownBlock = useMemo(() => repo.find(shownBlockId), [repo, shownBlockId])

  const handleSelect = useCallback((parent: Block) => {
    setShownBlockId(parent.id)
  }, [])

  const isUnfurled = shownBlockId !== block.id

  return (
    <div className="border-l-2 border-muted pl-3 py-2">
      <Suspense fallback={null}>
        <BacklinkBreadcrumbs shownBlock={shownBlock} onSelect={handleSelect}/>
      </Suspense>
      {isUnfurled && (
        <button
          type="button"
          onClick={() => setShownBlockId(block.id)}
          className="text-xs text-muted-foreground/70 hover:text-foreground mb-1"
        >
          ↩ collapse to reference
        </button>
      )}
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

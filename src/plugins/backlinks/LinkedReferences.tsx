import { Suspense, use, useMemo, useState } from 'react'
import { Block } from '@/data/block.ts'
import { BlockRendererProps } from '@/types.ts'
import { BlockComponent } from '@/components/BlockComponent.tsx'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useBacklinks } from '@/hooks/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { buildAppHash } from '@/utils/routing.ts'

const NESTED_OVERRIDES = {topLevel: false, isBacklink: true}

const BacklinkBreadcrumbs = ({block}: { block: Block }) => {
  const repo = useRepo()
  const workspaceId = repo.activeWorkspaceId
  const parents = use(useMemo(() => block.parents(), [block.id]))

  if (parents.length === 0 || !workspaceId) return null

  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground/80 mb-1 flex-wrap">
      {parents.map((parent) => (
        <span key={parent.id} className="flex items-center min-w-0">
          <a
            href={buildAppHash(workspaceId, parent.id)}
            className="no-underline cursor-pointer truncate max-w-[24ch] hover:text-foreground"
          >
            <span className="inline [&>*]:inline [&>p]:m-0 [&>*]:whitespace-nowrap [&>*]:overflow-hidden [&>*]:text-ellipsis [&>*]:font-normal [&>*]:text-inherit text-muted-foreground/80">
              <NestedBlockContextProvider overrides={{...NESTED_OVERRIDES, isBreadcrumb: true}}>
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

const BacklinkItem = ({block}: { block: Block }) => (
  <div className="border-l-2 border-muted pl-3 py-2">
    <Suspense fallback={null}>
      <BacklinkBreadcrumbs block={block}/>
    </Suspense>
    <NestedBlockContextProvider overrides={NESTED_OVERRIDES}>
      <BlockComponent blockId={block.id}/>
    </NestedBlockContextProvider>
  </div>
)

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

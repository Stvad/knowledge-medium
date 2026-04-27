import { Block } from '@/data/block.ts'
import { use, useMemo } from 'react'
import { BlockComponent } from '@/components/BlockComponent.tsx'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useRepo } from '@/context/repo.tsx'
import { buildAppHash } from '@/utils/routing.ts'

export const Breadcrumbs = ({block}: { block: Block }) => {
  const repo = useRepo()
  // App.tsx's bootstrap sets activeWorkspaceId before any block renders.
  const workspaceId = repo.activeWorkspaceId!
  const parents = use(useMemo(() => block.parents(), [block.id]))

  if (parents.length === 0) {
    return null
  }

  return (
    <div className="flex items-center gap-1 text-sm text-muted-foreground mb-2 overflow-x-auto py-1 flex-wrap">
      {parents.map((parent) => (
        <div key={parent.id} className="flex items-center min-w-0">
          <a
            href={buildAppHash(workspaceId, parent.id)}
            className="no-underline cursor-pointer truncate max-w-full"
          >
            <div className="inline [&>*]:inline [&>p]:m-0 [&>*]:whitespace-nowrap
            [&>*]:overflow-hidden [&>*]:text-ellipsis [&>*]:font-normal [&>*]:text-inherit
            text-muted-foreground">
              <NestedBlockContextProvider overrides={{isBreadcrumb: true}}>
                <BlockComponent blockId={parent.id}/>
              </NestedBlockContextProvider>
            </div>
          </a>
          <span className="mx-1 text-muted-foreground/50">›</span>
        </div>
      ))}
    </div>
  )
}

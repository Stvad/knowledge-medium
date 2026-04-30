import { Block } from '@/data/internals/block'
import { BreadcrumbList } from '@/components/BreadcrumbList.tsx'
import { useParents } from '@/hooks/block.ts'
import { useRepo } from '@/context/repo.tsx'

const OVERRIDES = {isBreadcrumb: true}

export const Breadcrumbs = ({block}: { block: Block }) => {
  const repo = useRepo()
  // App.tsx's bootstrap sets activeWorkspaceId before any block renders.
  const workspaceId = repo.activeWorkspaceId!
  const parents = useParents(block)

  return (
    <BreadcrumbList
      parents={parents}
      workspaceId={workspaceId}
      overrides={OVERRIDES}
      className="flex items-center gap-1 text-sm text-muted-foreground mb-2 overflow-x-auto py-1 flex-wrap"
      itemClassName="no-underline cursor-pointer truncate max-w-full"
      separatorClassName="mx-1 text-muted-foreground/50"
    />
  )
}

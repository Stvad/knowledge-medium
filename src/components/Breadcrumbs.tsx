import { Block } from '@/data/block.ts'
import { use, useMemo } from 'react'
import { BreadcrumbList } from '@/components/BreadcrumbList.tsx'
import { useRepo } from '@/context/repo.tsx'

const OVERRIDES = {isBreadcrumb: true}

export const Breadcrumbs = ({block}: { block: Block }) => {
  const repo = useRepo()
  // App.tsx's bootstrap sets activeWorkspaceId before any block renders.
  const workspaceId = repo.activeWorkspaceId!
  const parents = use(useMemo(() => block.parents(), [block.id]))

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

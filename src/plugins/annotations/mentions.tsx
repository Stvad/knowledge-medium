import {useMemo} from 'react'
import {MarkdownContentRenderer} from '@/components/renderer/MarkdownContentRenderer.js'
import {NestedBlockContextProvider, useBlockContext} from '@/context/block.js'
import {useAppHashInContext} from '@/context/layoutWsContext.js'
import {useRepo} from '@/context/repo.js'
import type {Block} from '@/data/block'
import {useParents, useWorkspaceId} from '@/hooks/block.js'
import {BreadcrumbList} from '@/plugins/breadcrumbs/BreadcrumbList.js'
import {ContributorCardView} from '@/plugins/contributors/ContributorBadges.js'
import {useOpenBlock} from '@/utils/navigation.js'
import {surfaceRenderScopeId} from '@/utils/renderScope.js'
import type {MarginMentions} from './mentionsQuery.js'

const CARD_CONTEXT = {isNestedSurface: true, layoutBoundary: false}
const BREADCRUMB_CONTEXT = {isNestedSurface: true, isBreadcrumb: true}

const SourceBody = ({block}: {block: Block}) => {
  const workspaceId = useWorkspaceId(block, block.repo.activeWorkspaceId ?? '')
  const openSource = useOpenBlock({blockId: block.id, workspaceId})
  const href = useAppHashInContext(workspaceId, block.id)
  return (
    <div className="relative rounded-sm hover:bg-muted/40">
      <div inert className="pointer-events-none">
        <MarkdownContentRenderer block={block}/>
      </div>
      <a href={href} onClick={openSource} aria-label="Open mention" className="absolute inset-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"/>
    </div>
  )
}

const MentionSourceCard = ({blockId, parentRenderScopeId}: {blockId: string; parentRenderScopeId: string}) => {
  const repo = useRepo()
  const source = repo.block(blockId)
  const workspaceId = useWorkspaceId(source, repo.activeWorkspaceId ?? '')
  const parents = useParents(source)
  const renderScopeId = useMemo(
    () => surfaceRenderScopeId('mentions', parentRenderScopeId, blockId),
    [parentRenderScopeId, blockId],
  )

  return (
    <article className="rounded-md border border-dashed border-muted-foreground/40 p-2">
      <div className="mb-1 text-xs text-muted-foreground">Mention</div>
      <NestedBlockContextProvider overrides={{
        ...CARD_CONTEXT,
        renderScopeId,
        scopeRootId: source.id,
      }}>
        <BreadcrumbList
          parents={parents}
          workspaceId={workspaceId}
          overrides={BREADCRUMB_CONTEXT}
          className="mb-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
          itemClassName="max-w-[24ch] cursor-pointer truncate no-underline hover:text-foreground"
          separatorClassName="mx-1 text-muted-foreground/40"
        />
        <ContributorCardView block={source} Inner={SourceBody}/>
      </NestedBlockContextProvider>
    </article>
  )
}

export const MentionCards = ({blockId, mentions}: {blockId: string; mentions: MarginMentions}) => {
  const repo = useRepo()
  const target = repo.block(blockId)
  const workspaceId = useWorkspaceId(target, repo.activeWorkspaceId ?? '')
  const blockContext = useBlockContext()
  const parentRenderScopeId = typeof blockContext.renderScopeId === 'string'
    ? blockContext.renderScopeId
    : 'annotations-margin'
  const openTarget = useOpenBlock({blockId, workspaceId})
  const targetHref = useAppHashInContext(workspaceId, blockId)
  const moreCount = mentions.total - mentions.ids.length
  return (
    <section aria-label="Mentions" className="space-y-2">
      {mentions.ids.map(sourceId => (
        <MentionSourceCard key={sourceId} blockId={sourceId} parentRenderScopeId={parentRenderScopeId}/>
      ))}
      {moreCount > 0 && (
        <a href={targetHref} onClick={openTarget} className="inline-block text-xs text-muted-foreground underline-offset-2 hover:underline">
          {moreCount} more
        </a>
      )}
    </section>
  )
}

import {useId, useMemo} from 'react'
import {MarkdownContentRenderer} from '@/components/renderer/MarkdownContentRenderer.js'
import {NestedBlockContextProvider, useBlockContext} from '@/context/block.js'
import {useAppHashInContext} from '@/context/layoutWsContext.js'
import {useRepo} from '@/context/repo.js'
import type {Block} from '@/data/block'
import {useWorkspaceId} from '@/hooks/block.js'
import {BreadcrumbList} from '@/plugins/breadcrumbs/BreadcrumbList.js'
import {BacklinksDialog} from '@/plugins/backlinks/BacklinksDialog.js'
import {ContributorCardView} from '@/plugins/contributors/ContributorBadges.js'
import {useBlockOpener, useOpenBlock} from '@/utils/navigation.js'
import {openDialog} from '@/utils/dialogs.js'
import {surfaceRenderScopeId} from '@/utils/renderScope.js'
import type {MarginMentions} from './mentionsQuery.js'

const CARD_CONTEXT = {isNestedSurface: true, layoutBoundary: false}
const BREADCRUMB_CONTEXT = {isNestedSurface: true, isBreadcrumb: true}

const SourceBody = ({block}: {block: Block}) => {
  const previewId = useId()
  const workspaceId = useWorkspaceId(block, block.repo.activeWorkspaceId ?? '')
  const openSource = useOpenBlock({blockId: block.id, workspaceId})
  const href = useAppHashInContext(workspaceId, block.id)
  return (
    <div className="relative rounded-sm hover:bg-muted/40">
      <div id={previewId} className="pointer-events-none">
        <MarkdownContentRenderer block={block}/>
      </div>
      <a href={href} onClick={openSource} aria-label="Open mention" aria-describedby={previewId} className="absolute inset-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"/>
    </div>
  )
}

const MentionSourceCard = ({blockId, parentIds, parentRenderScopeId}: {blockId: string; parentIds: readonly string[]; parentRenderScopeId: string}) => {
  const repo = useRepo()
  const source = repo.block(blockId)
  const workspaceId = useWorkspaceId(source, repo.activeWorkspaceId ?? '')
  const openBlock = useBlockOpener()
  const parents = parentIds.map(id => repo.block(id))
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
          onLinkClick={(event, parent) => openBlock(event, {blockId: parent.id, workspaceId})}
          className="mb-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
          itemClassName="max-w-[24ch] cursor-pointer truncate no-underline hover:text-foreground"
          separatorClassName="mx-1 text-muted-foreground/40"
        />
        <ContributorCardView block={source} Inner={SourceBody}/>
      </NestedBlockContextProvider>
    </article>
  )
}

export const MentionCards = ({blockId, panelId, mentions}: {blockId: string; panelId: string; mentions: MarginMentions}) => {
  const blockContext = useBlockContext()
  const parentRenderScopeId = surfaceRenderScopeId('mention-target', blockContext.renderScopeId ?? '', blockId)
  const moreCount = mentions.total - mentions.ids.length
  return (
    <section aria-label="Mentions" className="space-y-2">
      {mentions.ids.map(sourceId => (
        <MentionSourceCard key={sourceId} blockId={sourceId} parentIds={mentions.parentsBySource[sourceId]} parentRenderScopeId={parentRenderScopeId}/>
      ))}
      {moreCount > 0 && (
        <button type="button" onClick={() => void openDialog(BacklinksDialog, {blockId, panelId})} className="inline-block text-xs text-muted-foreground underline-offset-2 hover:underline">
          All references
        </button>
      )}
    </section>
  )
}

import { useCallback, useMemo } from 'react'
import { Block } from '@/data/block'
import { BlockLoadingPlaceholder } from '@/components/BlockLoadingPlaceholder.js'
import { BlockComponent } from '@/components/BlockComponent.js'
import { PromotableBreadcrumbList } from '@/plugins/breadcrumbs/PromotableBreadcrumbList.js'
import { usePromotableBreadcrumb } from '@/plugins/breadcrumbs/usePromotableBreadcrumb.js'
import { NestedBlockContextProvider, useBlockContext } from '@/context/block.js'
import { LazyViewportMount } from '@/components/util/LazyViewportMount.js'
import type { LazyViewportPlaceholderProps } from '@/components/util/LazyViewportMount.js'
import { useParents } from '@/hooks/block.js'
import { useRepo } from '@/context/repo.js'
import {
  backlinkEntryShortcutContextOverrides,
  promoteClosestBreadcrumb,
  type BacklinkEntryShortcutController,
} from './backlinkBreadcrumbShortcuts.ts'
import { backlinkRenderScopeId } from '@/utils/renderScope.js'

const NESTED_OVERRIDES = {layoutBoundary: false, isNestedSurface: true, isBacklink: true}
const BREADCRUMB_OVERRIDES = {...NESTED_OVERRIDES, isBreadcrumb: true}
const BACKLINK_ESTIMATED_HEIGHT_PX = 96
const BACKLINK_OVERSCAN_PX = 600
const BACKLINK_BLOCK_PLACEHOLDER_HEIGHT_PX = 32

const EMPTY_PARENTS: readonly Block[] = []
const EMPTY_BLOCK_IDS: readonly string[] = []

// Roam-style: breadcrumbs are the chain ABOVE the currently-shown block.
// Click a segment to "unfurl" — promote it to the shown block. The
// breadcrumb chain truncates accordingly and the body re-renders the
// chosen parent's subtree (which still contains the original backlink
// as a descendant).
//
// Two render paths so we can avoid an `useParents` query per visible
// entry in the *initial* state: when the parent component has already
// prefetched ancestors via `useManyParents`, it passes them in as
// `initialParents` and `BacklinkItemContent` renders without
// firing its own ancestor handle. After the user clicks a breadcrumb
// the shown block changes, the conditional flips, and
// `BacklinkDynamicContent` (which DOES use `useParents`) takes
// over for the new id. Conditional rendering is what gives us the
// query skip — React unmounts whichever branch we're not on.

const BacklinkItemContent = ({
  shownBlock,
  parents,
  onSelect,
  onShowBlock,
  renderScopeId,
  forceOpenBlockIds,
}: {
  shownBlock: Block
  parents: readonly Block[]
  onSelect: (parent: Block) => void
  onShowBlock: (blockId: string) => void
  renderScopeId: string
  forceOpenBlockIds?: readonly string[]
}) => {
  const repo = useRepo()
  const workspaceId = repo.activeWorkspaceId

  const promoteBreadcrumb = useCallback(
    () => promoteClosestBreadcrumb(parents, onShowBlock),
    [parents, onShowBlock],
  )
  const hasBreadcrumb = useCallback(
    () => parents.length > 0,
    [parents],
  )
  const shortcutController = useMemo<BacklinkEntryShortcutController>(() => ({
    promoteClosestBreadcrumb: promoteBreadcrumb,
    hasBreadcrumb,
  }), [promoteBreadcrumb, hasBreadcrumb])
  const bodyOverrides = useMemo(() => ({
    ...NESTED_OVERRIDES,
    renderScopeId,
    ...(forceOpenBlockIds?.length ? {forceOpenBlockIds} : {}),
    // The shown block is the root of this entry's visible subtree, so
    // structural edits (o / Enter / Tab) and bounded navigation treat
    // it like a panel's top-level block instead of restructuring the
    // real tree around it (which lives outside the entry).
    scopeRootId: shownBlock.id,
    ...backlinkEntryShortcutContextOverrides(shortcutController),
  }), [forceOpenBlockIds, renderScopeId, shownBlock.id, shortcutController])

  return (
    <>
      {workspaceId && (
        <PromotableBreadcrumbList
          parents={parents}
          workspaceId={workspaceId}
          overrides={BREADCRUMB_OVERRIDES}
          onPromote={onSelect}
          className="flex items-center gap-1 text-xs text-muted-foreground/80 mb-1 flex-wrap"
          itemClassName="no-underline cursor-pointer truncate max-w-[24ch] hover:text-foreground"
          separatorClassName="mx-1 text-muted-foreground/40"
        />
      )}
      <NestedBlockContextProvider overrides={bodyOverrides}>
        <BlockComponent blockId={shownBlock.id}/>
      </NestedBlockContextProvider>
    </>
  )
}

const BacklinkDynamicContent = ({
  shownBlock,
  onSelect,
  onShowBlock,
  renderScopeId,
  forceOpenBlockIds,
}: {
  shownBlock: Block
  onSelect: (parent: Block) => void
  onShowBlock: (blockId: string) => void
  renderScopeId: string
  forceOpenBlockIds?: readonly string[]
}) => {
  const parents = useParents(shownBlock)
  return (
    <BacklinkItemContent
      shownBlock={shownBlock}
      parents={parents}
      onSelect={onSelect}
      onShowBlock={onShowBlock}
      renderScopeId={renderScopeId}
      forceOpenBlockIds={forceOpenBlockIds}
    />
  )
}

const BacklinkItem = ({
  block,
  initialParents = EMPTY_PARENTS,
  scopeId,
}: {
  block: Block
  initialParents?: readonly Block[]
  scopeId: string
}) => {
  const repo = useRepo()
  const parentContext = useBlockContext()
  // Promote-in-place state (unfurl an ancestor, with the panel-nav
  // crossfade) shared with the SRS review session.
  const {shownId, isInitial, promote, showBlock} = usePromotableBreadcrumb(block.id)
  const shownBlock = useMemo(() => repo.block(shownId), [repo, shownId])
  const parentRenderScopeId = typeof parentContext.renderScopeId === 'string'
    ? parentContext.renderScopeId
    : 'backlinks-root'
  const renderScopeId = useMemo(
    () => backlinkRenderScopeId(parentRenderScopeId, scopeId),
    [parentRenderScopeId, scopeId],
  )
  const forceOpenBlockIds = useMemo(() => {
    if (shownId === block.id) return EMPTY_BLOCK_IDS
    const shownIndex = initialParents.findIndex(parent => parent.id === shownId)
    return shownIndex >= 0
      ? initialParents.slice(shownIndex).map(parent => parent.id)
      : EMPTY_BLOCK_IDS
  }, [block.id, initialParents, shownId])

  return (
    <div className="border-l-2 border-muted pl-3 py-2">
      {isInitial
        ? (
            <BacklinkItemContent
              shownBlock={shownBlock}
              parents={initialParents}
              onSelect={promote}
              onShowBlock={showBlock}
              renderScopeId={renderScopeId}
              forceOpenBlockIds={forceOpenBlockIds}
            />
          )
        : (
            <BacklinkDynamicContent
              shownBlock={shownBlock}
              onSelect={promote}
              onShowBlock={showBlock}
              renderScopeId={renderScopeId}
              forceOpenBlockIds={forceOpenBlockIds}
            />
          )}
    </div>
  )
}

const BacklinkItemPlaceholder = ({
  reservedHeight,
}: LazyViewportPlaceholderProps) => {
  return (
    <div
      className="border-l-2 border-muted pl-3 py-2"
      style={{minHeight: reservedHeight}}
      aria-hidden
    >
      <div className="mb-1 h-4 w-40 max-w-full rounded-sm bg-muted/60" />
      <BlockLoadingPlaceholder reservedHeight={BACKLINK_BLOCK_PLACEHOLDER_HEIGHT_PX} />
    </div>
  )
}

export const LazyBacklinkItem = ({
  block,
  initialParents,
  scopeId,
}: {
  block: Block
  initialParents?: readonly Block[]
  scopeId: string
}) => {
  return (
    <LazyViewportMount
      cacheKey={`backlink:${scopeId}:${block.id}`}
      estimatedHeightPx={BACKLINK_ESTIMATED_HEIGHT_PX}
      overscanPx={BACKLINK_OVERSCAN_PX}
      renderPlaceholder={(props) => <BacklinkItemPlaceholder {...props} />}
    >
      <BacklinkItem block={block} initialParents={initialParents} scopeId={scopeId} />
    </LazyViewportMount>
  )
}

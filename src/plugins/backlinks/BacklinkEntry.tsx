import { useCallback, useMemo, useState, type MouseEvent } from 'react'
import { Block } from '@/data/block'
import { BlockLoadingPlaceholder } from '@/components/BlockLoadingPlaceholder.js'
import { BlockComponent } from '@/components/BlockComponent.js'
import { BreadcrumbList } from '@/plugins/breadcrumbs/BreadcrumbList.js'
import { NestedBlockContextProvider, useBlockContext } from '@/context/block.js'
import { LazyViewportMount } from '@/components/util/LazyViewportMount.js'
import type { LazyViewportPlaceholderProps } from '@/components/util/LazyViewportMount.js'
import { useParents } from '@/hooks/block.js'
import { useRepo } from '@/context/repo.js'
import { useBlockOpener } from '@/utils/navigation.js'
import { withMoveTransition } from '@/utils/viewTransition.js'
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

interface BacklinkBreadcrumbListProps {
  parents: readonly Block[]
  workspaceId: string
  onSelect: (parent: Block) => void
}

const BacklinkBreadcrumbList = ({parents, workspaceId, onSelect}: BacklinkBreadcrumbListProps) => {
  const openBlock = useBlockOpener()
  const handleLinkClick = useCallback((event: MouseEvent, parent: Block) => {
    openBlock(event, {blockId: parent.id, workspaceId})
  }, [openBlock, workspaceId])

  return (
    <BreadcrumbList
      parents={parents}
      workspaceId={workspaceId}
      overrides={BREADCRUMB_OVERRIDES}
      onSelect={onSelect}
      onLinkClick={handleLinkClick}
      className="flex items-center gap-1 text-xs text-muted-foreground/80 mb-1 flex-wrap"
      itemClassName="no-underline cursor-pointer truncate max-w-[24ch] hover:text-foreground"
      separatorClassName="mx-1 text-muted-foreground/40"
    />
  )
}

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
}: {
  shownBlock: Block
  parents: readonly Block[]
  onSelect: (parent: Block) => void
  onShowBlock: (blockId: string) => void
  renderScopeId: string
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
    // The shown block is the root of this entry's visible subtree, so
    // structural edits (o / Enter / Tab) and bounded navigation treat
    // it like a panel's top-level block instead of restructuring the
    // real tree around it (which lives outside the entry).
    scopeRootId: shownBlock.id,
    ...backlinkEntryShortcutContextOverrides(shortcutController),
  }), [renderScopeId, shownBlock.id, shortcutController])

  return (
    <>
      {workspaceId && (
        <BacklinkBreadcrumbList parents={parents} workspaceId={workspaceId} onSelect={onSelect}/>
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
}: {
  shownBlock: Block
  onSelect: (parent: Block) => void
  onShowBlock: (blockId: string) => void
  renderScopeId: string
}) => {
  const parents = useParents(shownBlock)
  return (
    <BacklinkItemContent
      shownBlock={shownBlock}
      parents={parents}
      onSelect={onSelect}
      onShowBlock={onShowBlock}
      renderScopeId={renderScopeId}
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
  const [shownBlockId, setShownBlockId] = useState(block.id)
  const shownBlock = useMemo(() => repo.block(shownBlockId), [repo, shownBlockId])
  const isInitial = shownBlockId === block.id
  const parentRenderScopeId = typeof parentContext.renderScopeId === 'string'
    ? parentContext.renderScopeId
    : 'backlinks-root'
  const renderScopeId = useMemo(
    () => backlinkRenderScopeId(parentRenderScopeId, scopeId),
    [parentRenderScopeId, scopeId],
  )

  // Wrap in withMoveTransition so unfurling the breadcrumb chain gets
  // the same crossfade as panel breadcrumb navigation. The state change
  // is local React (`setShownBlockId`), not a DB write — `navigateInPanel`'s
  // internal wrap doesn't help here, so the wrap lives at the call site.
  const handleSelect = useCallback((parent: Block) => {
    void withMoveTransition(async () => {
      setShownBlockId(parent.id)
    })
  }, [])
  const handleShowBlock = useCallback((blockId: string) => {
    void withMoveTransition(async () => {
      setShownBlockId(blockId)
    })
  }, [])

  return (
    <div className="border-l-2 border-muted pl-3 py-2">
      {isInitial
        ? (
            <BacklinkItemContent
              shownBlock={shownBlock}
              parents={initialParents}
              onSelect={handleSelect}
              onShowBlock={handleShowBlock}
              renderScopeId={renderScopeId}
            />
          )
        : (
            <BacklinkDynamicContent
              shownBlock={shownBlock}
              onSelect={handleSelect}
              onShowBlock={handleShowBlock}
              renderScopeId={renderScopeId}
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

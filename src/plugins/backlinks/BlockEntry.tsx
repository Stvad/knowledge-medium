import { useCallback, useMemo } from 'react'
import { Block } from '@/data/block'
import { BlockLoadingPlaceholder } from '@/components/BlockLoadingPlaceholder.js'
import { BlockComponent } from '@/components/BlockComponent.js'
import { PromotableBreadcrumbList } from '@/plugins/breadcrumbs/PromotableBreadcrumbList.js'
import { usePromotableBreadcrumb } from '@/plugins/breadcrumbs/usePromotableBreadcrumb.js'
import { NestedBlockContextProvider, useBlockContext } from '@/context/block.js'
import { LazyViewportMount } from '@/components/util/LazyViewportMount.js'
import type { LazyViewportPlaceholderProps } from '@/components/util/LazyViewportMount.js'
import { useResolvedParents } from '@/hooks/block.js'
import { useRepo } from '@/context/repo.js'
import {
  backlinkEntryShortcutContextOverrides,
  promoteClosestBreadcrumb,
  type BacklinkEntryShortcutController,
} from './backlinkBreadcrumbShortcuts.ts'
import { backlinkRenderScopeId } from '@/utils/renderScope.js'

/** One block rendered OUT of its tree position — lazily viewport-mounted,
 *  with a promotable breadcrumb chain above it. Nothing here is specific to
 *  reference queries; it's the generic "list of blocks from somewhere else"
 *  entry, and linked references were just its first consumer (hence the
 *  directory). The readwise review backlog renders its highlights with it too.
 *
 *  `isBacklink` in the context overrides below is deliberate and NOT a
 *  leftover: it names the SURFACE KIND, which is what
 *  `spatial-navigation/surface.ts` and the breadcrumb-promote shortcut in
 *  `backlinkBreadcrumbShortcuts.ts` key on. Every consumer of this entry
 *  wants both of those behaviours, so the flag travels with the component
 *  rather than becoming a prop. */
const NESTED_OVERRIDES = {layoutBoundary: false, isNestedSurface: true, isBacklink: true}
const BREADCRUMB_OVERRIDES = {...NESTED_OVERRIDES, isBreadcrumb: true}
const EMPTY_PARENTS: readonly Block[] = []
const ENTRY_ESTIMATED_HEIGHT_PX = 96
const ENTRY_OVERSCAN_PX = 600
const ENTRY_BLOCK_PLACEHOLDER_HEIGHT_PX = 32

// Roam-style: breadcrumbs are the chain ABOVE the currently-shown block.
// Click a segment to "unfurl" — promote it to the shown block. The
// breadcrumb chain truncates accordingly and the body re-renders the
// chosen parent's subtree (which still contains the original backlink
// as a descendant).
//
// The chain comes from the entry's own `core.ancestors` handle, keyed by
// the shown id — so a promote re-keys it, and the walks of every entry
// that mounts in one commit coalesce into a single statement.
//
// `initialParents` OWNS the chain for the block the caller handed over.
// Where a caller supplies one it is authoritative, not a placeholder: it is
// derived (the readwise backlog builds each highlight's from its section's)
// or captured (the grouped panel's snapshot, which a paused panel
// deliberately freezes), and in both cases it is the answer this entry
// should paint. The walk covers the rest — an un-supplied chain, and the
// promoted block, which sits on a different chain the caller never
// described.
//
// The walk is subscribed either way, which is the price of ONE render
// path: the shape this replaces put it in a second component, so promoting
// swapped the component TYPE at this position and remounted the body.

const BlockEntryContent = ({
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

const BlockEntry = ({
  block,
  initialParents,
  scopeId,
}: {
  block: Block
  /** This block's chain, from a caller that already knows it. Wins over
   *  the entry's own walk for as long as this block is the one shown, so a
   *  caller whose chain is deliberately FROZEN (the grouped panel while
   *  paused) keeps the breadcrumb its grouping was built from.
   *
   *  `undefined` and `[]` say different things and both are honoured:
   *  "I have no opinion, go and walk" versus "this block has no
   *  ancestors". */
  initialParents?: readonly Block[]
  scopeId: string
}) => {
  const repo = useRepo()
  const parentContext = useBlockContext()
  // Promote-in-place state (unfurl an ancestor, with the panel-nav
  // crossfade) shared with the SRS review session.
  const {shownId, promote, showBlock} = usePromotableBreadcrumb(block.id)
  const shownBlock = useMemo(() => repo.block(shownId), [repo, shownId])
  // `undefined` is "no opinion" and `[]` is "no ancestors" — a distinction
  // the supplier means, and the reason this tests for the property rather
  // than for a non-empty array.
  const walked = useResolvedParents(shownBlock)
  const supplied = shownId === block.id ? initialParents : undefined
  const parents = supplied ?? walked ?? EMPTY_PARENTS
  const parentRenderScopeId = typeof parentContext.renderScopeId === 'string'
    ? parentContext.renderScopeId
    : 'backlinks-root'
  const renderScopeId = useMemo(
    () => backlinkRenderScopeId(parentRenderScopeId, scopeId),
    [parentRenderScopeId, scopeId],
  )

  return (
    <div className="border-l-2 border-muted pl-3 py-2">
      <BlockEntryContent
        shownBlock={shownBlock}
        parents={parents}
        onSelect={promote}
        onShowBlock={showBlock}
        renderScopeId={renderScopeId}
      />
    </div>
  )
}

const BlockEntryPlaceholder = ({
  reservedHeight,
}: LazyViewportPlaceholderProps) => {
  return (
    <div
      className="border-l-2 border-muted pl-3 py-2"
      style={{minHeight: reservedHeight}}
      aria-hidden
    >
      <div className="mb-1 h-4 w-40 max-w-full rounded-sm bg-muted/60" />
      <BlockLoadingPlaceholder reservedHeight={ENTRY_BLOCK_PLACEHOLDER_HEIGHT_PX} />
    </div>
  )
}

export const LazyBlockEntry = ({
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
      blockId={block.id}
      estimatedHeightPx={ENTRY_ESTIMATED_HEIGHT_PX}
      overscanPx={ENTRY_OVERSCAN_PX}
      renderPlaceholder={(props) => <BlockEntryPlaceholder {...props} />}
    >
      <BlockEntry block={block} initialParents={initialParents} scopeId={scopeId} />
    </LazyViewportMount>
  )
}

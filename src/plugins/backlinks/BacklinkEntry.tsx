import { useCallback, useMemo, useState, type MouseEvent } from 'react'
import { Block } from '@/data/block'
import { BlockLoadingPlaceholder } from '@/components/BlockLoadingPlaceholder.js'
import { BlockComponent } from '@/components/BlockComponent.js'
import { BreadcrumbList } from '@/plugins/breadcrumbs/BreadcrumbList.js'
import { NestedBlockContextProvider } from '@/context/block.js'
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
}: {
  shownBlock: Block
  parents: readonly Block[]
  onSelect: (parent: Block) => void
  onShowBlock: (blockId: string) => void
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
    ...backlinkEntryShortcutContextOverrides(shortcutController),
  }), [shortcutController])

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
}: {
  shownBlock: Block
  onSelect: (parent: Block) => void
  onShowBlock: (blockId: string) => void
}) => {
  const parents = useParents(shownBlock)
  return (
    <BacklinkItemContent
      shownBlock={shownBlock}
      parents={parents}
      onSelect={onSelect}
      onShowBlock={onShowBlock}
    />
  )
}

const BacklinkItem = ({
  block,
  initialParents = EMPTY_PARENTS,
}: {
  block: Block
  initialParents?: readonly Block[]
}) => {
  const repo = useRepo()
  const [shownBlockId, setShownBlockId] = useState(block.id)
  const shownBlock = useMemo(() => repo.block(shownBlockId), [repo, shownBlockId])
  const isInitial = shownBlockId === block.id

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
            />
          )
        : (
            <BacklinkDynamicContent
              shownBlock={shownBlock}
              onSelect={handleSelect}
              onShowBlock={handleShowBlock}
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
}: {
  block: Block
  initialParents?: readonly Block[]
}) => {
  return (
    <LazyViewportMount
      cacheKey={`backlink:${block.id}`}
      estimatedHeightPx={BACKLINK_ESTIMATED_HEIGHT_PX}
      overscanPx={BACKLINK_OVERSCAN_PX}
      renderPlaceholder={(props) => <BacklinkItemPlaceholder {...props} />}
    >
      <BacklinkItem block={block} initialParents={initialParents}/>
    </LazyViewportMount>
  )
}

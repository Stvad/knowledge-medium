/**
 * A card zoomed into one comment of its thread: the card shows that comment's
 * subtree in place of the whole thread, under a line of crumbs that lead back
 * out. The zoom itself is view state (`uiStore.ts`), set by a zoom made inside
 * the card (`threadNavigation.ts`).
 */

import {ChevronRight} from 'lucide-react'
import type {BlockData} from '@/data/api'
import {useRepo} from '@/context/repo.js'
import {useHandle} from '@/hooks/block.js'
import {firstLine, truncate} from '@/utils/string.js'
import type {ThreadAnchor} from './schema.ts'
import {setCardZoom} from './uiStore.ts'

export interface ZoomCrumb {
  id: string
  label: string
}

const CRUMB_CHARS = 32

/** The comments between a thread's root and a block zoomed into, outermost
 *  first, from that block's ancestors (nearest first). Null when they don't
 *  reach the root: the block is no longer in the thread. */
export const zoomCrumbs = (
  ancestors: readonly Pick<BlockData, 'id' | 'content'>[],
  threadId: string,
): ZoomCrumb[] | null => {
  const root = ancestors.findIndex(ancestor => ancestor.id === threadId)
  if (root < 0) return null
  return ancestors.slice(0, root).reverse()
    .map(({id, content}) => ({id, label: truncate(firstLine(content.trimStart()), CRUMB_CHARS)}))
}

export interface CardZoom {
  /** The comment the card shows. */
  blockId: string
  crumbs: readonly ZoomCrumb[]
}

const NO_CRUMBS: readonly ZoomCrumb[] = Object.freeze([])

/** The zoom of a card asked to show `zoomed`, or null where that block has
 *  left the thread. While its ancestors are being read the card is zoomed,
 *  without its inner crumbs: falling back to the whole thread until they
 *  arrive would remount the card twice. */
export const useCardZoomIn = (zoomed: string, threadId: string): CardZoom | null => {
  const repo = useRepo()
  const crumbs = useHandle(repo.query.ancestors({id: zoomed}), {
    selector: chain => chain ? zoomCrumbs(chain.ancestors, threadId) : NO_CRUMBS,
  })
  return crumbs ? {blockId: zoomed, crumbs} : null
}

const rootLabel = (anchor: ThreadAnchor): string =>
  anchor.kind === 'block' ? 'Thread' : `“${truncate(firstLine(anchor.quote), CRUMB_CHARS)}”`

const Crumb = ({label, onClick}: {label: string; onClick: () => void}) => (
  <>
    <button
      type="button"
      onClick={event => { event.stopPropagation(); onClick() }}
      className="max-w-full truncate hover:text-foreground hover:underline"
    >
      {label || '…'}
    </button>
    <ChevronRight className="h-3 w-3 shrink-0" aria-hidden/>
  </>
)

export const CardZoomCrumbs = ({cardScope, anchor, zoom}: {cardScope: string; anchor: ThreadAnchor; zoom: CardZoom}) => (
  <nav aria-label="Zoomed in comment thread" className="flex flex-wrap items-center gap-x-0.5 px-1 text-xs text-muted-foreground">
    <Crumb label={rootLabel(anchor)} onClick={() => setCardZoom(cardScope, null)}/>
    {zoom.crumbs.map(crumb => (
      <Crumb key={crumb.id} label={crumb.label} onClick={() => setCardZoom(cardScope, crumb.id)}/>
    ))}
  </nav>
)

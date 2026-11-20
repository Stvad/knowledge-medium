import type { ComponentProps, ReactNode } from 'react'
import { defineFacet, isFunction } from '@/facets/facet.js'

export interface BlockLinkTarget {
  blockId: string
  workspaceId: string
}

export type BlockLinkAnchorProps = ComponentProps<'a'>

export interface BlockLinkDecoratorProps {
  link: BlockLinkTarget
  anchorProps: BlockLinkAnchorProps
  /** Renders the link (and its context menu) with the given anchor props.
   *  Whatever a decorator renders beside it sits outside the anchor. */
  children: (anchorProps: BlockLinkAnchorProps) => ReactNode
}

export type BlockLinkDecorator = (props: BlockLinkDecoratorProps) => ReactNode

/** Hook-safe extension point on every internal link (`BlockLink`: block
 *  references, aliased references, page links). Each decorator wraps the link
 *  with a render-prop transform of its anchor props, like
 *  `blockShellDecoratorsFacet` does for the block shell. */
export const blockLinkDecoratorsFacet = defineFacet<BlockLinkDecorator, readonly BlockLinkDecorator[]>({
  id: 'core.block-link-decorators',
  validate: isFunction<BlockLinkDecorator>,
})

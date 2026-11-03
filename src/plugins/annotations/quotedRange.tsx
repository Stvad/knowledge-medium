/**
 * A thread root rendered as a reference: `((T))` in another block reads as the
 * quoted part of T's target, in quotation marks. That is a range reference.
 *
 * A reference's inner content is the block renderer's own read renderer, not
 * a `blockContentRendererFacet` variant, so this is a reference LAYOUT for
 * thread roots, in place of `referenceLayout.tsx`'s. It keeps that layout's
 * link to T and puts plain inline content inside it, with no controls.
 *
 * An anchor that resolves, exact or moved, finds the quote verbatim in the
 * target, so the root's content IS the live text of the range. Once the target
 * no longer holds it, the same text shows as it was, marked.
 */

import type {BlockData} from '@/data/api'
import type {Block} from '@/data/block'
import {MarkdownContentRenderer} from '@/components/renderer/MarkdownContentRenderer.js'
import {ReferenceLink} from '@/components/references/ReferenceLink.js'
import type {BlockLayout, BlockLayoutContribution} from '@/extensions/blockInteraction.js'
import {useHandle} from '@/hooks/block.js'
import {firstLine, truncate} from '@/utils/string.js'
import {useAnchorState, type AnchorState} from './anchorState.ts'
import {THREAD_TYPE, threadAnchorOf} from './schema.ts'

const QUOTE_MARKS: Partial<Record<AnchorState, string>> = {
  stale: 'quoted text changed',
  deleted: 'source deleted',
}

const QuotedRange = ({block, root}: {block: Block; root: Pick<BlockData, 'content' | 'properties'>}) => {
  const {state, targetContent} = useAnchorState(root)
  const mark = QUOTE_MARKS[state]
  return (
    <span data-quote-state={state} className={mark ? 'text-muted-foreground' : undefined}>
      “
      {threadAnchorOf(root).kind === 'range'
        ? <MarkdownContentRenderer block={block}/>
        // A whole-block thread quotes all of its target.
        : truncate(firstLine(targetContent ?? ''), 80)}
      ”
      {mark && <span className="ml-1 text-[0.75em]">({mark})</span>}
    </span>
  )
}

const QuotedRangeLayout: BlockLayout = ({block}) => {
  const root = useHandle(block, {selector: data => data && {content: data.content, properties: data.properties}})
  return <ReferenceLink block={block}>{root && <QuotedRange block={block} root={root}/>}</ReferenceLink>
}

export const quotedRangeLayoutContribution: BlockLayoutContribution = ctx =>
  ctx.blockContext?.isReference && ctx.types.includes(THREAD_TYPE)
    ? {id: 'annotations.quoted-range', label: 'Quoted range', render: QuotedRangeLayout}
    : null

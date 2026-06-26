/** Block content decorator that overlays a live character count on any
 *  block tagged `CHAR_COUNTER_TYPE`. A decorator (not a renderer override)
 *  so it composes with whatever content renderer the block already uses —
 *  the count is absolutely positioned at the content's bottom-right corner
 *  so the block keeps its usual footprint (no extra row pushing siblings
 *  down). `pointer-events-none` keeps the overlay from stealing clicks /
 *  text selection from the editor underneath.
 *
 *  Reactive state (content + limit) is read inside the rendered component
 *  via hooks, per `BlockResolveContext`'s contract — the contribution
 *  itself only gates on `ctx.types`. Cached per inner renderer so React
 *  keeps a stable component identity and never unmounts the inner subtree
 *  on a parent re-render (same invariant as geoContentDecorator). */

import type { Block } from '@/data/block.js'
import { useContent, useProperty } from '@/hooks/block.js'
import {
  type BlockContentDecorator,
  type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types.js'
import { CHAR_COUNTER_TYPE } from './blockType'
import { charLimitProp } from './properties'
import { charCountDisplay } from './charCount'

interface CharacterCountDecoratorProps {
  block: Block
  Inner: BlockRenderer
}

const CharacterCountDecorator = ({block, Inner}: CharacterCountDecoratorProps) => {
  const content = useContent(block)
  const [limit] = useProperty(block, charLimitProp)
  const {text, over} = charCountDisplay(content.length, limit)
  return (
    <div className="relative w-full">
      <Inner block={block}/>
      <span
        className={`pointer-events-none absolute bottom-0 right-0 select-none text-xs tabular-nums ${over ? 'text-destructive' : 'text-muted-foreground'}`}
        aria-label="Character count"
      >
        {text}
      </span>
    </div>
  )
}

const cache = new WeakMap<BlockRenderer, BlockRenderer>()

const decorate: BlockContentDecorator = inner => {
  const existing = cache.get(inner)
  if (existing) return existing
  const Decorated: BlockRenderer = ({block}) => (
    <CharacterCountDecorator block={block} Inner={inner}/>
  )
  Decorated.displayName = 'WithCharacterCount'
  cache.set(inner, Decorated)
  return Decorated
}

export const characterCountDecoratorContribution: BlockContentDecoratorContribution = ctx =>
  ctx.types.includes(CHAR_COUNTER_TYPE) ? decorate : null

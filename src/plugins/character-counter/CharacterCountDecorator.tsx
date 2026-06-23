/** Block content decorator that appends a live character count to any
 *  block tagged `CHAR_COUNTER_TYPE`. A decorator (not a renderer override)
 *  so it composes with whatever content renderer the block already uses —
 *  the count just rides below it.
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
    <div className="flex w-full flex-col gap-1">
      <Inner block={block}/>
      <span
        className={`self-end text-xs tabular-nums ${over ? 'text-destructive' : 'text-muted-foreground'}`}
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

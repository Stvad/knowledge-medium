/** Block content decorator that overlays live counts. A tagged block can count
 *  itself (`char:scope=self`), configure counters for its direct children
 *  (`char:scope=children`), or show one total for its whole subtree
 *  (`char:scope=subtree`). The decorator stays generic by resolving count
 *  behavior through `characterCountProfilesFacet`; plugins persist only the
 *  profile id in `char:profile`.
 *
 *  A decorator (not a renderer override) so it composes with whatever content
 *  renderer the block already uses. Counts are absolutely positioned at the
 *  content's bottom-right corner and `pointer-events-none` keeps the overlay
 *  from stealing clicks / text selection from the editor underneath.
 *
 *  The contribution applies globally so children can inspect their parent
 *  config, but the rendered component returns the inner renderer unchanged
 *  when neither self nor inherited config applies. Cached per inner renderer
 *  so React keeps a stable component identity and never unmounts the inner
 *  subtree on a parent re-render (same invariant as geoContentDecorator). */

import type { Block } from '@/data/block.js'
import { getBlockTypes } from '@/data/properties.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { useHandle, useProperty } from '@/hooks/block.js'
import {
  type BlockContentDecorator,
  type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types.js'
import { CHAR_COUNTER_TYPE } from './blockType'
import { charLimitProp, charProfileProp, charScopeProp } from './properties'
import { charCountDisplay } from './charCount'
import {
  characterCountProfilesFacet,
  profileFrom,
  profileLabel,
  type CharacterCountProfile,
} from './profiles'

interface CounterConfig {
  limit: number | undefined
  profileId: string | undefined
  /** Sum over the block's subtree instead of counting the block alone. */
  subtreeTotal: boolean
}

interface CharacterCountDecoratorProps {
  block: Block
  Inner: BlockRenderer
}

const blockInfoSelector = (data: ReturnType<Block['peek']>) => ({
  parentId: data?.parentId ?? null,
  types: data ? getBlockTypes(data) : [],
})

const BadgeText = ({
  profile,
  text,
  over = false,
}: {
  profile: CharacterCountProfile
  text: string
  over?: boolean
}) => (
  <span
    className={`pointer-events-none absolute bottom-0 right-0 select-none text-xs tabular-nums ${over ? 'text-destructive' : 'text-muted-foreground'}`}
    aria-label={`${profileLabel(profile)} count`}
  >
    {text}
  </span>
)

interface BadgeProps {
  block: Block
  profile: CharacterCountProfile
  limit: number | undefined
}

const BlockCountBadge = ({block, profile, limit}: BadgeProps) => {
  const {text, over} = charCountDisplay(profile.useCount(block), limit)
  return <BadgeText profile={profile} text={text} over={over}/>
}

const SubtreeCountBadge = ({
  block,
  profile,
  limit,
  countText,
}: BadgeProps & {countText: (content: string) => number}) => {
  const total = useHandle(block.repo.query.subtree({id: block.id, hidePropertyChildren: true}), {
    selector: rows => rows?.reduce((sum, row) => sum + countText(row.content), 0),
  })
  // Nothing until the subtree has loaded: an empty sum would read as a real 0.
  if (total === undefined) return null
  const {text, over} = charCountDisplay(total, limit)
  return <BadgeText profile={profile} text={text} over={over}/>
}

const CountBadge = ({block, config}: {block: Block, config: CounterConfig}) => {
  const runtime = useAppRuntime()
  const profiles = runtime.read(characterCountProfilesFacet)
  const profile = profileFrom(profiles, config.profileId)

  // Keyed by profile id: profiles' `useCount` hooks differ, so switching
  // profiles must remount rather than change the hook sequence in place.
  if (!config.subtreeTotal) {
    return <BlockCountBadge key={profile.id} block={block} profile={profile} limit={config.limit}/>
  }
  if (!profile.countText) {
    return <BadgeText profile={profile} text={`${profileLabel(profile)}: no subtree total`}/>
  }
  return (
    <SubtreeCountBadge
      key={profile.id}
      block={block}
      profile={profile}
      limit={config.limit}
      countText={profile.countText}
    />
  )
}

const CounterFrame = ({
  block,
  Inner,
  config,
}: CharacterCountDecoratorProps & {config: CounterConfig}) => (
  <div className="relative w-full">
    <Inner block={block}/>
    <CountBadge block={block} config={config}/>
  </div>
)

interface InheritedCharacterCountDecoratorProps extends CharacterCountDecoratorProps {
  parentId: string
}

const InheritedCharacterCountDecorator = ({
  block,
  parentId,
  Inner,
}: InheritedCharacterCountDecoratorProps) => {
  const parent = block.repo.block(parentId)
  const parentTypes = useHandle(parent, {
    selector: data => data ? getBlockTypes(data) : [],
  })
  const [parentScope] = useProperty(parent, charScopeProp)
  const [parentLimit] = useProperty(parent, charLimitProp)
  const [parentProfileId] = useProperty(parent, charProfileProp)
  const applies =
    parentTypes.includes(CHAR_COUNTER_TYPE) &&
    parentScope === 'children'

  if (!applies) return <Inner block={block}/>

  return (
    <CounterFrame
      block={block}
      Inner={Inner}
      config={{limit: parentLimit, profileId: parentProfileId, subtreeTotal: false}}
    />
  )
}

const CharacterCountDecorator = ({block, Inner}: CharacterCountDecoratorProps) => {
  const info = useHandle(block, {selector: blockInfoSelector})
  const [scope] = useProperty(block, charScopeProp)
  const [limit] = useProperty(block, charLimitProp)
  const [profileId] = useProperty(block, charProfileProp)
  const selfApplies =
    info.types.includes(CHAR_COUNTER_TYPE) &&
    (scope === 'self' || scope === 'subtree')

  if (selfApplies) {
    return (
      <CounterFrame
        block={block}
        Inner={Inner}
        config={{limit, profileId, subtreeTotal: scope === 'subtree'}}
      />
    )
  }

  if (info.parentId) {
    return (
      <InheritedCharacterCountDecorator
        block={block}
        parentId={info.parentId}
        Inner={Inner}
      />
    )
  }

  return <Inner block={block}/>
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

export const characterCountDecoratorContribution: BlockContentDecoratorContribution = () =>
  decorate

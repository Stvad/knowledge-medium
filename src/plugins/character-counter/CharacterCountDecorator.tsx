/** Block content decorator that overlays live character counts. A tagged block
 *  can count itself (`char:scope=self`) or configure counters for its direct
 *  children (`char:scope=children`). The decorator stays generic by resolving
 *  count behavior through `characterCountProfilesFacet`; plugins persist only
 *  the profile id in `char:profile`.
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
import { useContent, useHandle, useProperty } from '@/hooks/block.js'
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
  RAW_CHARACTER_COUNT_PROFILE_ID,
  type CharacterCountProfile,
} from './profiles'

interface CounterConfig {
  limit: number | undefined
  profileId: string | undefined
}

interface CharacterCountDecoratorProps {
  block: Block
  Inner: BlockRenderer
}

const blockInfoSelector = (data: ReturnType<Block['peek']>) => ({
  parentId: data?.parentId ?? null,
  types: data ? getBlockTypes(data) : [],
})

const useRawCharacterCount = (block: Block): number => useContent(block).length

const rawCharacterCountProfile: CharacterCountProfile = {
  id: RAW_CHARACTER_COUNT_PROFILE_ID,
  useCount: useRawCharacterCount,
}

const profileFrom = (
  profiles: ReadonlyMap<string, CharacterCountProfile>,
  id: string | undefined,
): CharacterCountProfile =>
  (id ? profiles.get(id) : undefined) ?? rawCharacterCountProfile

interface ResolvedCounterConfig extends CounterConfig {
  profile: CharacterCountProfile
}

const ProfileCountBadge = ({
  block,
  config,
}: {
  block: Block
  config: ResolvedCounterConfig
}) => {
  const profile = config.profile
  const length = profile.useCount(block)
  const {text, over} = charCountDisplay(length, config.limit)

  return (
    <span
      className={`pointer-events-none absolute bottom-0 right-0 select-none text-xs tabular-nums ${over ? 'text-destructive' : 'text-muted-foreground'}`}
      aria-label="Character count"
    >
      {text}
    </span>
  )
}

const CountBadge = ({block, config}: {block: Block, config: CounterConfig}) => {
  const runtime = useAppRuntime()
  const profiles = runtime.read(characterCountProfilesFacet)
  const profile = profileFrom(profiles, config.profileId)

  return (
    <ProfileCountBadge
      key={profile.id}
      block={block}
      config={{...config, profile}}
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
      config={{limit: parentLimit, profileId: parentProfileId}}
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
    scope === 'self'

  if (selfApplies) {
    return (
      <CounterFrame
        block={block}
        Inner={Inner}
        config={{limit, profileId}}
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

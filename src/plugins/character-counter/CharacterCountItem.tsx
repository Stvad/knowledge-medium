/** Gutter item that shows live counts in a block's bottom-right corner. A
 *  tagged block can count itself (`char:scope=self`), configure counters for
 *  its direct children (`char:scope=children`), or show one total for its
 *  whole subtree (`char:scope=subtree`). The item stays generic by resolving
 *  count behavior through `characterCountProfilesFacet`; plugins persist only
 *  the profile id in `char:profile`.
 *
 *  A gutter item (not a renderer override) so it composes with whatever
 *  content renderer the block already uses, and the host reserves the row
 *  under the content, so the count never covers text.
 *
 *  The contribution applies globally so children can inspect their parent
 *  config; the component renders null when neither self nor inherited config
 *  applies. */

import { useCallback } from 'react'
import type { Handle, SubtreeRow } from '@/data/api'
import type { Block } from '@/data/block.js'
import { typesProp } from '@/data/properties.js'
import { safeDecodeRowProperty } from '@/data/rowProperty'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { useHandle, useProperty } from '@/hooks/block.js'
import type {
  BlockGutterItem,
  BlockGutterItemContribution,
} from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types.js'
import { useParsedBlockQuery } from '@/plugins/tables/query/source'
import { useTableQueryFacets } from '@/plugins/tables/query/registrations'
import { COUNTER_TYPES } from './blockType'
import { charExcludeProp, charLimitProp, charProfileProp, charScopeProp } from './properties'
import { charCountDisplay } from './charCount'
import { COUNTER_SUBTREE_QUERY } from './subtree'
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

const isCounter = (types: readonly string[]): boolean =>
  types.some(type => COUNTER_TYPES.includes(type))

const blockInfoSelector = (data: ReturnType<Block['peek']>) => ({
  parentId: data?.parentId ?? null,
  types: data ? safeDecodeRowProperty(data, typesProp) : [],
})

const BadgeText = ({
  profile,
  text,
  over = false,
  title,
}: {
  profile: CharacterCountProfile
  text: string
  over?: boolean
  title?: string
}) => (
  <span
    className={`select-none text-xs tabular-nums ${over ? 'text-destructive' : 'text-muted-foreground'}`}
    aria-label={`${profileLabel(profile)} count`}
    title={title}
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

type TextCountBadgeProps = BadgeProps & {countText: (content: string) => number}

const SubtreeTotal = ({
  handle,
  profile,
  limit,
  countText,
}: Omit<TextCountBadgeProps, 'block'> & {handle: Handle<SubtreeRow[]>}) => {
  const sumRows = useCallback(
    (rows: readonly {content: string}[] | undefined) =>
      rows?.reduce((sum, row) => sum + countText(row.content), 0),
    [countText],
  )
  const total = useHandle(handle, {selector: sumRows})
  // Nothing until the subtree has loaded: an empty sum would read as a real 0.
  if (total === undefined) return null
  const {text, over} = charCountDisplay(total, limit)
  return <BadgeText profile={profile} text={text} over={over}/>
}

const FilteredSubtreeCount = ({block, query, ...badge}: TextCountBadgeProps & {query: string}) => {
  const workspaceId = useHandle(block, {selector: row => row?.workspaceId ?? ''})
  const facets = useTableQueryFacets(workspaceId)
  const parsed = useParsedBlockQuery(block, workspaceId, query, facets, true)
  if (!workspaceId || !parsed) return null
  const error = parsed.errors[0]
  if (error) return <BadgeText profile={badge.profile} text="Invalid exclusion query" title={error.message} over/>
  const handle = block.repo.query[COUNTER_SUBTREE_QUERY]({id: block.id, exclude: {workspaceId, ...parsed.query}})
  return <SubtreeTotal handle={handle} {...badge}/>
}

const SubtreeCountBadge = ({block, ...badge}: TextCountBadgeProps) => {
  const [exclude] = useProperty(block, charExcludeProp)
  if (exclude.trim()) return <FilteredSubtreeCount block={block} query={exclude} {...badge}/>
  return <SubtreeTotal handle={block.repo.query.subtree({id: block.id, propertyChildren: 'none'})} {...badge}/>
}

const CountBadge = ({block, config}: {block: Block, config: CounterConfig}) => {
  const runtime = useAppRuntime()
  const profiles = runtime.read(characterCountProfilesFacet)
  const profile = profileFrom(profiles, config.profileId)

  if (!config.subtreeTotal) {
    // Keyed by profile id: profiles' `useCount` hooks differ, so switching
    // profiles must remount rather than change the hook sequence in place.
    return <BlockCountBadge key={profile.id} block={block} profile={profile} limit={config.limit}/>
  }
  if (!profile.countText) {
    return <BadgeText profile={profile} text={`${profileLabel(profile)}: no subtree total`}/>
  }
  return (
    <SubtreeCountBadge
      block={block}
      profile={profile}
      limit={config.limit}
      countText={profile.countText}
    />
  )
}

const InheritedCountBadge = ({block, parentId}: {block: Block, parentId: string}) => {
  const parent = block.repo.block(parentId)
  const parentTypes = useHandle(parent, {
    selector: data => data ? safeDecodeRowProperty(data, typesProp) : [],
  })
  const [parentScope] = useProperty(parent, charScopeProp)
  const [parentLimit] = useProperty(parent, charLimitProp)
  const [parentProfileId] = useProperty(parent, charProfileProp)
  const applies =
    isCounter(parentTypes) &&
    parentScope === 'children'

  if (!applies) return null

  return (
    <CountBadge
      block={block}
      config={{limit: parentLimit, profileId: parentProfileId, subtreeTotal: false}}
    />
  )
}

const CharacterCountItem: BlockRenderer = ({block}) => {
  const info = useHandle(block, {selector: blockInfoSelector})
  const [scope] = useProperty(block, charScopeProp)
  const [limit] = useProperty(block, charLimitProp)
  const [profileId] = useProperty(block, charProfileProp)
  const selfApplies =
    isCounter(info.types) &&
    (scope === 'self' || scope === 'subtree')

  if (selfApplies) {
    return (
      <CountBadge
        block={block}
        config={{limit, profileId, subtreeTotal: scope === 'subtree'}}
      />
    )
  }

  if (info.parentId) {
    return <InheritedCountBadge block={block} parentId={info.parentId}/>
  }

  return null
}

const countItem: BlockGutterItem = {corner: 'bottom-right', component: CharacterCountItem}

export const characterCountItemContribution: BlockGutterItemContribution = () => countItem

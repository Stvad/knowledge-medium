import type { Block } from '@/data/block.js'
import { defineFacet, isFunction } from '@/facets/facet.js'

export const RAW_CHARACTER_COUNT_PROFILE_ID = 'raw'

export interface CharacterCountProfile {
  id: string
  useCount: (block: Block) => number
}

const isCharacterCountProfile = (value: unknown): value is CharacterCountProfile => {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<CharacterCountProfile>
  return typeof candidate.id === 'string' && isFunction(candidate.useCount)
}

export const characterCountProfilesFacet = defineFacet<
  CharacterCountProfile,
  ReadonlyMap<string, CharacterCountProfile>
>({
  id: 'character-counter.profiles',
  combine: values => {
    const out = new Map<string, CharacterCountProfile>()
    for (const value of values) {
      if (out.has(value.id)) {
        console.warn(
          `[character-counter.profiles] duplicate registration for "${value.id}"; last-wins per facet convention`,
        )
      }
      out.set(value.id, value)
    }
    return out
  },
  empty: () => new Map(),
  validate: isCharacterCountProfile,
})

import type { Block } from '@/data/block.js'
import { defineFacet, isFunction } from '@/facets/facet.js'
import { useContent } from '@/hooks/block.js'
import { countCharacters, countWords } from './textCounts'

export const RAW_CHARACTER_COUNT_PROFILE_ID = 'raw'
export const WORDS_COUNT_PROFILE_ID = 'words'

export interface CharacterCountProfile {
  id: string
  /** Shown in the `char:profile` picker; the id when omitted. */
  label?: string
  useCount: (block: Block) => number
  /** A pure count of one block's content. `char:scope=subtree` sums it over
   *  every block in the subtree, which a per-block hook cannot do, so a
   *  profile without it is reported as unsupported in that scope. */
  countText?: (content: string) => number
}

export const profileLabel = (profile: CharacterCountProfile): string =>
  profile.label ?? profile.id

/** A profile that counts the block's own content with a pure function, which
 *  also makes it usable for subtree totals. */
export const textCountProfile = (
  id: string,
  label: string,
  countText: (content: string) => number,
): CharacterCountProfile => ({
  id,
  label,
  countText,
  useCount: block => countText(useContent(block)),
})

export const rawCharacterCountProfile = textCountProfile(
  RAW_CHARACTER_COUNT_PROFILE_ID, 'Characters', countCharacters,
)
export const wordsCountProfile = textCountProfile(
  WORDS_COUNT_PROFILE_ID, 'Words', countWords,
)

const isCharacterCountProfile = (value: unknown): value is CharacterCountProfile => {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<CharacterCountProfile>
  return typeof candidate.id === 'string'
    && isFunction(candidate.useCount)
    && (candidate.label === undefined || typeof candidate.label === 'string')
    && (candidate.countText === undefined || isFunction(candidate.countText))
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

export const builtinCountProfiles = [rawCharacterCountProfile, wordsCountProfile].map(
  profile => characterCountProfilesFacet.of(profile, {source: 'character-counter'}),
)

/** The profile `char:profile` names, or the raw character count when it is
 *  unset or names a profile no installed plugin registers. */
export const profileFrom = (
  profiles: ReadonlyMap<string, CharacterCountProfile>,
  id: string | undefined,
): CharacterCountProfile =>
  (id ? profiles.get(id) : undefined) ?? rawCharacterCountProfile

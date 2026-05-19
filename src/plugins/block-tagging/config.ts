import {
  ChangeScope,
  defineBlockType,
  defineProperty,
  type Codec,
} from '@/data/api'

const uniqueStrings = (value: unknown): string[] =>
  Array.from(new Set(
    Array.isArray(value)
      ? value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean)
      : [],
  ))

/** Tag names are interpolated into a wikilink (`[[name]]`). The
 *  reference parser balances `[[ … ]]` pairs, so a name containing
 *  either delimiter would parse into a different alias than what the
 *  user typed. `renderWikilink` already munges `]]` (with a lossy
 *  space-split), but it does not touch `[[` — `"foo[[bar"` renders
 *  as `"[[foo[[bar]]"` and parses back as alias `"bar"`. Rather than
 *  silently corrupting input, reject names containing either
 *  delimiter at the entry points (dialog, config editor, append
 *  helpers). */
export const isValidTagName = (name: string): boolean => {
  const trimmed = name.trim()
  if (!trimmed) return false
  if (trimmed.includes('[[')) return false
  if (trimmed.includes(']]')) return false
  return true
}

export const normalizeBlockTagsConfig = (value: unknown): string[] =>
  uniqueStrings(value)

const blockTagsConfigCodec: Codec<string[]> = {
  type: 'blockTagging:tagsConfig',
  encode: normalizeBlockTagsConfig,
  decode: normalizeBlockTagsConfig,
}

/** Per-workspace list of tag names available to the "add tag" group
 *  action. Each entry is a bare page name — the action appends
 *  ` [[name]]` to each selected block's content if not already
 *  present (no `#` prefix, matching how the user writes tags
 *  inline). */
export const blockTagsConfigProp = defineProperty<string[]>(
  'blockTagging:tagsConfig',
  {
    codec: blockTagsConfigCodec,
    defaultValue: [],
    changeScope: ChangeScope.UserPrefs,
  },
)

/** Per-plugin prefs sub-block for the block-tagging plugin. Holds
 *  `blockTagsConfigProp` (the user's curated tag list). */
export const blockTaggingPrefsType = defineBlockType({
  id: 'block-tagging-prefs',
  label: 'Block tagging preferences',
  properties: [blockTagsConfigProp],
})

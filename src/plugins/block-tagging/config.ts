import {
  ChangeScope,
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

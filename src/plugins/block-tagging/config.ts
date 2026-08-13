import {
  ChangeScope,
  seedType,
  definePresetCore,
  seedProperty,
  type Codec,
} from '@/data/api'
import { uniqueStrings } from '@/utils/array'
import { MAX_ALIAS_LENGTH } from '@/plugins/references/referenceParser'

/** Tag names are interpolated into a wikilink (`[[name]]`). The
 *  reference parser balances `[[ … ]]` pairs, so a name containing
 *  either delimiter would parse into a different alias than what the
 *  user typed. `renderWikilink` munges both delimiters (with a lossy
 *  space-split), so the rendered link stays structurally sound but no
 *  longer carries the name the user typed. Rather than silently
 *  altering input, reject names containing either delimiter at the
 *  entry points (dialog, config editor, append helpers).
 *
 *  Length is rejected here for the same reason and at the same seam. The
 *  parser refuses to read an over-`MAX_ALIAS_LENGTH` span as a wikilink,
 *  so emitting one produces literal `[[…]]` markup that never becomes a
 *  link and never gains a backlink — and `appendTagToBlocks` would still
 *  count the block as tagged, because it decides that on string
 *  inequality alone. Both tag entry points take FREE TEXT (the add-tag
 *  dialog's input and the config editor's draft field), so nothing
 *  upstream bounds this. Refusing beats silently writing dead markup. */
export const isValidTagName = (name: string): boolean => {
  const trimmed = name.trim()
  if (!trimmed) return false
  if (trimmed.length > MAX_ALIAS_LENGTH) return false
  if (trimmed.includes('[[')) return false
  if (trimmed.includes(']]')) return false
  return true
}

export const normalizeBlockTagsConfig = (value: unknown): string[] =>
  uniqueStrings(value)

export const blockTagsConfigCodec: Codec<string[]> = {
  type: 'blockTagging:tagsConfig',
  encode: normalizeBlockTagsConfig,
  decode: normalizeBlockTagsConfig,
}

export const blockTagsConfigPresetCore = definePresetCore<string[]>({
  id: blockTagsConfigCodec.type,
  build: () => blockTagsConfigCodec,
  defaultValue: [],
})

/** Per-workspace list of tag names available to the "add tag" group
 *  action. Each entry is a bare page name — the action appends
 *  ` [[name]]` to each selected block's content if not already
 *  present (no `#` prefix, matching how the user writes tags
 *  inline). */
export const blockTagsConfigProp = seedProperty({
  seedKey: 'system:block-tagging/property/tags-config',
  revision: 1,
  name: 'blockTagging:tagsConfig',
  preset: blockTagsConfigPresetCore,
  defaultValue: [],
  changeScope: ChangeScope.UserPrefs,
})

/** Per-plugin prefs sub-block for the block-tagging plugin. Holds
 *  `blockTagsConfigProp` (the user's curated tag list). */
export const blockTaggingPrefsType = seedType({
  seedKey: 'system:block-tagging/type/block-tagging-prefs',
  revision: 1,
  id: 'block-tagging-prefs',
  label: 'Tags',
  properties: [blockTagsConfigProp],
})

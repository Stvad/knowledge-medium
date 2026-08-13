import {
  ChangeScope,
  seedType,
  definePresetCore,
  seedProperty,
  type Codec,
} from '@/data/api'
import { uniqueStrings } from '@/utils/array'
import { canRenderAsWikilink } from '@/plugins/references/referenceParser'

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
 *  upstream bounds this. Refusing beats silently writing dead markup.
 *
 *  The length check is on the RENDERED span, not on `trimmed`, and that
 *  distinction is load-bearing: `renderWikilink` appends a space after a
 *  trailing `]` to keep the closing delimiter balanced, so a name of
 *  exactly `MAX_ALIAS_LENGTH` ending in `]` emits an alias one character
 *  OVER the cap. Comparing `trimmed.length` would wave it through.
 *  Parsing what the renderer actually emits is the only form of this
 *  check that cannot drift from the renderer (Codex on PR #540). */
export const isValidTagName = (name: string): boolean =>
  tagNameIssue(name) === null

/** WHY a tag name was rejected, so the entry points can say something
 *  true. They used to hard-code "can't contain `[[` or `]]`", which was
 *  the only rule; the length rule made that message a lie for an input
 *  containing neither delimiter — the control went disabled with an
 *  error naming characters that weren't there and no hint that
 *  shortening would fix it (Codex on PR #540). A reason code rather than
 *  a string so each surface keeps its own markup for the delimiters. */
export type TagNameIssue = 'empty' | 'delimiters' | 'too-long'

export const tagNameIssue = (name: string): TagNameIssue | null => {
  const trimmed = name.trim()
  if (!trimmed) return 'empty'
  if (trimmed.includes('[[') || trimmed.includes(']]')) return 'delimiters'
  if (!canRenderAsWikilink(trimmed)) return 'too-long'
  return null
}

export const normalizeBlockTagsConfig = (value: unknown): string[] =>
  uniqueStrings(value)

/** Configured tags this build can actually apply.
 *
 *  Stored prefs are not guaranteed valid: the config editor accepted
 *  unbounded names before the alias cap and `normalizeBlockTagsConfig`
 *  preserves whatever is there, so prefs written by an older build can
 *  hold a name that no longer passes. Offering one in the picker made
 *  clicking it a silent no-op — the submit path bails on
 *  `isValidTagName` and the picker's error line is derived from the
 *  TYPED QUERY, which is usually empty, so the user got neither a tag nor
 *  a reason (Codex on PR #540).
 *
 *  For the PICKER only. The config editor deliberately shows every stored
 *  tag, valid or not — it is where an unusable one gets removed, and
 *  hiding it there would make it unreachable as well as unusable. */
export const selectableTagNames = (value: unknown): string[] =>
  normalizeBlockTagsConfig(value).filter(isValidTagName)

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

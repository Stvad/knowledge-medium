import { ChangeScope, codecs, defineBlockType, defineProperty } from '@/data/api'

/** Default variant id when no contributor matches the user's saved
 *  preference (or before any pref has been written). The
 *  backlinksViewFacet variants from the `backlinks` and
 *  `grouped-backlinks` plugins use these ids; keeping the constant
 *  here means the coordinator can fall through to "flat" without
 *  importing either plugin. */
export const DEFAULT_BACKLINKS_VIEW_ID = 'flat'

/** Which backlinks-view variant the user prefers. Synced via
 *  UserPrefs (per-workspace, per-user) so the choice follows the user
 *  across devices. There is intentionally no per-block override yet —
 *  if it turns out per-block selection is wanted, mirror the
 *  grouped-backlinks defaults/overrides split (`BlockDefault` scope,
 *  optional string, falls back to this prop). */
export const backlinksViewProp = defineProperty<string>('backlinks:viewId', {
  codec: codecs.string,
  defaultValue: DEFAULT_BACKLINKS_VIEW_ID,
  changeScope: ChangeScope.UserPrefs,
})

/** Per-plugin prefs sub-block under the user-prefs root. Holds
 *  `backlinksViewProp` (and any future backlinks-view preference) so that
 *  unrelated plugins' settings can't be clobbered by a PATCH on this
 *  block's `properties_json`. */
export const backlinksViewPrefsType = defineBlockType({
  id: 'backlinks-view-prefs',
  label: 'Backlinks view preferences',
  properties: [backlinksViewProp],
})

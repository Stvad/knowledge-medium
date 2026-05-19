import {
  ChangeScope,
  defineBlockType,
  defineProperty,
  type BlockData,
} from '@/data/api'
import { hasBlockType } from '@/data/properties.ts'
import { DAILY_NOTE_TYPE } from '@/plugins/daily-notes/schema.ts'
import {
  EMPTY_BACKLINKS_FILTER,
  backlinksFilterCodec,
  type StoredBacklinksFilter,
} from './filterProperty.ts'
import {
  mergeBacklinksFilters,
  normalizeBacklinksFilter,
  type BacklinksFilter,
} from './query.ts'

export const INITIAL_DAILY_NOTE_BACKLINKS_DEFAULTS: StoredBacklinksFilter = EMPTY_BACKLINKS_FILTER

export const dailyNoteBacklinksDefaultsProp = defineProperty<StoredBacklinksFilter>(
  'dailyNotes:backlinksPredicates',
  {
    codec: backlinksFilterCodec,
    defaultValue: EMPTY_BACKLINKS_FILTER,
    changeScope: ChangeScope.UserPrefs,
  },
)

/** Per-plugin prefs sub-block for the backlinks plugin. Currently holds
 *  only the daily-note backlinks default filter; per-block filters live
 *  on the target block itself (`backlinksFilterProp`, BlockDefault scope). */
export const backlinksPrefsType = defineBlockType({
  id: 'backlinks-prefs',
  label: 'Backlinks',
  properties: [dailyNoteBacklinksDefaultsProp],
})

export const isDailyNoteBlockData = (
  data: Pick<BlockData, 'properties'> | null | undefined,
): boolean => Boolean(data && hasBlockType(data, DAILY_NOTE_TYPE))

export const defaultBacklinksFilterForBlock = (
  data: Pick<BlockData, 'properties'> | null | undefined,
  dailyNoteDefaults: BacklinksFilter | undefined,
): StoredBacklinksFilter =>
  isDailyNoteBlockData(data)
    ? normalizeBacklinksFilter(dailyNoteDefaults)
    : EMPTY_BACKLINKS_FILTER

export const effectiveBacklinksFilterForBlock = (
  data: Pick<BlockData, 'properties'> | null | undefined,
  localFilter: BacklinksFilter | undefined,
  dailyNoteDefaults: BacklinksFilter | undefined,
): StoredBacklinksFilter =>
  isDailyNoteBlockData(data)
    ? mergeBacklinksFilters(dailyNoteDefaults, localFilter)
    : normalizeBacklinksFilter(localFilter)

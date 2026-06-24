import {
  ChangeScope,
  codecs,
  defineBlockType,
  defineProperty,
  type BlockData,
  type Codec,
} from '@/data/api'

export interface GroupedBacklinksConfig {
  highPriorityTags: string[]
  lowPriorityTags: string[]
  excludedTags: string[]
  excludedPatterns: string[]
}

export interface GroupedBacklinksOverrides {
  highPriorityTags?: string[]
  lowPriorityTags?: string[]
  excludedTags?: string[]
  excludedPatterns?: string[]
}

export const EMPTY_GROUPED_BACKLINKS_CONFIG: GroupedBacklinksConfig = {
  highPriorityTags: [],
  lowPriorityTags: [],
  excludedTags: [],
  excludedPatterns: [],
}

const EMPTY_GROUPED_BACKLINKS_OVERRIDES: GroupedBacklinksOverrides = {}

export const INITIAL_GROUPED_BACKLINKS_CONFIG: GroupedBacklinksConfig = {
  highPriorityTags: [],
  lowPriorityTags: [
    'reflection',
    'task',
    'weekly review',
    'person',
  ],
  excludedTags: [
    'ptr',
    'otter.ai/transcript',
    'otter.ai',
    'TODO',
    'DONE',
    'factor',
    'interval',
    'isa',
    'repeat interval',
    'make-public',
    'matrix-messages',
    // Type-name exclusions: kernel infrastructure types that land on
    // essentially every block and would produce a useless mega-group
    // under type enrichment. Users can drop these from their config if
    // they actually want to group by "page-ness" or daily-note-ness.
    'page',
    'daily-note',
  ],
  excludedPatterns: [
    '^\\[\\[factor]]:.+',
    '^\\[\\[interval]]:.+',
    '^\\d{4}-\\d{2}-\\d{2}$',
    '^[A-Z][a-z]+ \\d{1,2}(st|nd|rd|th), \\d{4}$',
  ],
}

const uniqueStrings = (value: unknown): string[] =>
  Array.from(new Set(
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean)
      : [],
  ))

const stringList = (record: Record<string, unknown>, key: string): string[] =>
  uniqueStrings(record[key])

const optionalStringList = (
  record: Record<string, unknown>,
  key: string,
): string[] | undefined =>
  Object.hasOwn(record, key) ? uniqueStrings(record[key]) : undefined

const recordFrom = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

export const normalizeGroupedBacklinksConfig = (
  value: unknown,
): GroupedBacklinksConfig => {
  const record = recordFrom(value)
  return {
    highPriorityTags: stringList(record, 'highPriorityTags'),
    lowPriorityTags: stringList(record, 'lowPriorityTags'),
    excludedTags: stringList(record, 'excludedTags'),
    excludedPatterns: stringList(record, 'excludedPatterns'),
  }
}

export const normalizeGroupedBacklinksOverrides = (
  value: unknown,
): GroupedBacklinksOverrides => {
  const record = recordFrom(value)
  return {
    highPriorityTags: optionalStringList(record, 'highPriorityTags'),
    lowPriorityTags: optionalStringList(record, 'lowPriorityTags'),
    excludedTags: optionalStringList(record, 'excludedTags'),
    excludedPatterns: optionalStringList(record, 'excludedPatterns'),
  }
}

export const mergeGroupedBacklinksConfig = (
  defaults: GroupedBacklinksConfig,
  overrides: GroupedBacklinksOverrides,
): GroupedBacklinksConfig => ({
  highPriorityTags: overrides.highPriorityTags ?? defaults.highPriorityTags,
  lowPriorityTags: overrides.lowPriorityTags ?? defaults.lowPriorityTags,
  excludedTags: overrides.excludedTags ?? defaults.excludedTags,
  excludedPatterns: overrides.excludedPatterns ?? defaults.excludedPatterns,
})

/** Read a target block's per-block grouping overrides off its decoded
 *  block data. Shared by the React hook (`useGroupedBacklinksConfig`)
 *  and the non-React resolver (`resolveGroupedBacklinksConfig`) so both
 *  read the override property the same way. */
export const selectGroupedBacklinksOverrides = (
  data: Pick<BlockData, 'properties'> | null | undefined,
): GroupedBacklinksOverrides => {
  const stored = data?.properties[groupedBacklinksOverridesProp.name]
  return stored === undefined
    ? groupedBacklinksOverridesProp.defaultValue
    : groupedBacklinksOverridesProp.codec.decode(stored)
}

const groupedBacklinksConfigCodec: Codec<GroupedBacklinksConfig> = {
  type: 'groupedBacklinks:config',
  encode: normalizeGroupedBacklinksConfig,
  decode: normalizeGroupedBacklinksConfig,
}

const groupedBacklinksOverridesCodec: Codec<GroupedBacklinksOverrides> = {
  type: 'groupedBacklinks:overrides',
  encode: normalizeGroupedBacklinksOverrides,
  decode: normalizeGroupedBacklinksOverrides,
}

export const groupedBacklinksDefaultsProp = defineProperty<GroupedBacklinksConfig>(
  'groupedBacklinks:defaults',
  {
    codec: groupedBacklinksConfigCodec,
    defaultValue: INITIAL_GROUPED_BACKLINKS_CONFIG,
    changeScope: ChangeScope.UserPrefs,
  },
)

export const groupedBacklinksOverridesProp = defineProperty<GroupedBacklinksOverrides>(
  'groupedBacklinks:overrides',
  {
    codec: groupedBacklinksOverridesCodec,
    defaultValue: EMPTY_GROUPED_BACKLINKS_OVERRIDES,
    changeScope: ChangeScope.BlockDefault,
  },
)

/** Per-plugin prefs sub-block for grouped-backlinks defaults. The
 *  defaults live here (UserPrefs scope); per-block overrides keep using
 *  `groupedBacklinksOverridesProp` on the target block itself. */
export const groupedBacklinksPrefsType = defineBlockType({
  id: 'grouped-backlinks-prefs',
  label: 'Grouped backlinks',
  properties: [groupedBacklinksDefaultsProp],
})

/** Property name for `groupWith` — set on a block X to say "anything
 *  referencing X should also be grouped under [[Y]]". Values are
 *  projected into `block_references` with `source_field='groupWith'`
 *  (via `projectPropertyReferences`), which the grouped-backlinks
 *  query reads to expand each backlink's group set. */
export const GROUP_WITH_PROP_NAME = 'groupWith'

export const groupWithProp = defineProperty<readonly string[]>(GROUP_WITH_PROP_NAME, {
  codec: codecs.refList(),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

import {
  ChangeScope,
  defineProperty,
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

const groupedBacklinksConfigCodec: Codec<GroupedBacklinksConfig> = {
  shape: 'object',
  encode: normalizeGroupedBacklinksConfig,
  decode: normalizeGroupedBacklinksConfig,
}

const groupedBacklinksOverridesCodec: Codec<GroupedBacklinksOverrides> = {
  shape: 'object',
  encode: normalizeGroupedBacklinksOverrides,
  decode: normalizeGroupedBacklinksOverrides,
}

export const groupedBacklinksDefaultsProp = defineProperty<GroupedBacklinksConfig>(
  'groupedBacklinks:defaults',
  {
    codec: groupedBacklinksConfigCodec,
    defaultValue: EMPTY_GROUPED_BACKLINKS_CONFIG,
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

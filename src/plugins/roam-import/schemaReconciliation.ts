/** Phase 4 of the Roam import: every imported `key:: value` attribute
 *  becomes a registered property schema instead of an unschemaed JSON
 *  blob. See user-defined-properties.md §8.
 *
 *  Classification rules (sampled across all planned blocks):
 *    - all values are `[[…]]` page tokens          → 'refList' preset
 *    - all values are finite numbers               → 'number' preset
 *    - all values are true/false                   → 'boolean' preset
 *    - mixed string scalars + string arrays         → 'list' preset
 *    - otherwise                                   → 'string' preset
 *
 *  refList classification is paired with `normalizeRefPropertyValues`
 *  which walks every planned block and converts `[[X]]` token strings
 *  into id arrays (resolved via the importer's aliasIdMap). Without
 *  this normalization, the refList codec's `decode(string[])` would
 *  reject the raw token strings on first read.
 */

import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'
import {
  ROAM_PAGE_ALIAS_PROP,
  collectAliasesFromRoamSemanticRefListValue,
  inferRefListTargetTypes,
  isDailyNoteAlias,
  isRoamSemanticRefListProperty,
  parsePageTokenList,
} from './properties'

type ClassifiedPresetId = 'string' | 'number' | 'boolean' | 'list' | 'refList'

interface SampledNameStats {
  totalValues: number
  numbers: number
  booleans: number
  /** Strings that parse as a pure page-token list (`[[X]]`,
   *  `[[X]] [[Y]]`, `[[X]], [[Y]]` — see `isPageTokenListValue`). */
  pageTokenStrings: number
  /** Array values that contain only page-token strings (the explosion
   *  path in `propertiesFromRoam` already produces these). */
  pageTokenArrays: number
  /** Array values whose items are plain strings (no `[[X]]` wrapping).
   *  These map to the `list` preset, not `refList`, since the strings
   *  aren't aliases to resolve — we keep them as-is in the value. */
  plainStringArrays: number
  /** Scalar strings that are not pure `[[X]]` token lists. If these
   *  appear alongside plainStringArrays, the field is a string-list
   *  property whose scalar cases need one-item-array normalization. */
  plainStrings: number
  /** Token aliases extracted from every pure-token value seen — feeds
   *  `inferRefListTargetTypes` so a property whose targets are all
   *  daily notes lands on `targetTypes: ['daily-note']` and shows up
   *  with the date filter affordance in the backlinks UI. */
  refListTokensTotal: number
  refListTokensDailyNote: number
  nonRefListSamples: Array<{blockRef: string; value: string}>
}

const SCHEMA_NEAR_MISS_THRESHOLD = 0.85
const SCHEMA_NEAR_MISS_MIN_VALUES = 10

const formatSampleValue = (value: unknown): string => {
  let formatted: string
  try {
    const json = JSON.stringify(value)
    formatted = json === undefined ? String(value) : json
  } catch {
    formatted = String(value)
  }
  const normalized = formatted.replace(/\s+/g, ' ').trim()
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized
}

const rememberNonRefListSample = (
  stats: SampledNameStats,
  blockId: string,
  value: unknown,
): void => {
  stats.nonRefListSamples.push({blockRef: `((${blockId}))`, value: formatSampleValue(value)})
}

const isPureTokenString = (value: string): boolean => {
  return parsePageTokenList(value) !== null
}

const tallyTokens = (stats: SampledNameStats, value: string): void => {
  const tokens = parsePageTokenList(value)
  if (!tokens) return
  for (const {alias} of tokens) {
    stats.refListTokensTotal += 1
    if (isDailyNoteAlias(alias)) stats.refListTokensDailyNote += 1
  }
}

const recordSample = (stats: SampledNameStats, blockId: string, value: unknown): void => {
  stats.totalValues += 1
  if (typeof value === 'number' && Number.isFinite(value)) {
    stats.numbers += 1
    rememberNonRefListSample(stats, blockId, value)
    return
  }
  if (typeof value === 'boolean') {
    stats.booleans += 1
    rememberNonRefListSample(stats, blockId, value)
    return
  }
  if (typeof value === 'string' && isPureTokenString(value)) {
    stats.pageTokenStrings += 1
    tallyTokens(stats, value)
    return
  }
  if (typeof value === 'string') {
    stats.plainStrings += 1
    rememberNonRefListSample(stats, blockId, value)
    return
  }
  if (Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')) {
    if (value.every(item => isPureTokenString(item as string))) {
      stats.pageTokenArrays += 1
      for (const item of value as string[]) tallyTokens(stats, item)
    } else {
      stats.plainStringArrays += 1
      rememberNonRefListSample(stats, blockId, value)
    }
    return
  }
  rememberNonRefListSample(stats, blockId, value)
}

const classify = (stats: SampledNameStats): ClassifiedPresetId => {
  if (stats.totalValues === 0) return 'string'
  if (stats.numbers === stats.totalValues) return 'number'
  if (stats.booleans === stats.totalValues) return 'boolean'
  if (stats.pageTokenStrings + stats.pageTokenArrays === stats.totalValues) return 'refList'
  // Pure scalar strings remain 'string'. Once any value is a plain
  // string-array, though, the property is structurally a list; scalar
  // string cases are normalized to one-item arrays before writing.
  const plainTextValues = stats.plainStrings + stats.plainStringArrays
  if (stats.plainStringArrays > 0 && plainTextValues === stats.totalValues) return 'list'
  return 'string'
}

const schemaNearMissDiagnostic = (
  name: string,
  stats: SampledNameStats,
  effectivePreset: string,
  schemaSource: 'existing' | 'inferred',
): string | null => {
  if (stats.totalValues < SCHEMA_NEAR_MISS_MIN_VALUES) return null
  if (effectivePreset !== 'string' && effectivePreset !== 'list') return null

  const refListLike = stats.pageTokenStrings + stats.pageTokenArrays
  if (refListLike === 0 || refListLike === stats.totalValues) return null
  const ratio = refListLike / stats.totalValues
  if (ratio < SCHEMA_NEAR_MISS_THRESHOLD) return null

  const sourceLabel = schemaSource === 'existing'
    ? `uses existing ${effectivePreset} schema`
    : `inferred ${effectivePreset}`
  const percent = Math.round(ratio * 100)
  const nonRefListValues = stats.totalValues - refListLike
  const samples = stats.nonRefListSamples.length > 0
    ? ` Misses: ${stats.nonRefListSamples
      .map(sample => `${sample.blockRef}=${sample.value}`)
      .join('; ')}.`
    : ''
  return (
    `Schema inference near-miss: property "${name}" ${sourceLabel}, but ` +
    `${refListLike}/${stats.totalValues} values (${percent}%) looked like refList; ` +
    `${nonRefListValues} non-refList value(s) kept it from refList.${samples}`
  )
}

/** Plan-time reconciliation: collect every property name appearing on
 *  any planned block, skip kernel/plugin/already-registered names and
 *  hidden reserved slots, classify the rest by sampling values across
 *  the planned set, and produce a list of {name, presetId} pairs to
 *  register before the import writes content. */
export interface ReconciliationRegistration {
  readonly name: string
  readonly presetId: ClassifiedPresetId
  /** Inferred when every observed token alias resolves to a single known
   *  target type (currently only daily-note). Omitted otherwise — the
   *  schema lands with no `targetTypes` constraint and the user can
   *  refine via `RefTargetTypePicker`. */
  readonly targetTypes?: readonly string[]
}

export const collectSchemaReconciliationPlan = (
  blocks: ReadonlyArray<BlockData>,
  repo: Repo,
): {
  toRegister: ReadonlyArray<ReconciliationRegistration>
  skippedReserved: ReadonlyArray<string>
  diagnostics: ReadonlyArray<string>
} => {
  const sampler = new Map<string, SampledNameStats>()

  for (const block of blocks) {
    if (!block.properties) continue
    for (const [name, value] of Object.entries(block.properties)) {
      const stats = sampler.get(name) ?? {
        totalValues: 0,
        numbers: 0,
        booleans: 0,
        pageTokenStrings: 0,
        pageTokenArrays: 0,
        plainStringArrays: 0,
        plainStrings: 0,
        refListTokensTotal: 0,
        refListTokensDailyNote: 0,
        nonRefListSamples: [],
      }
      recordSample(stats, block.id, value)
      sampler.set(name, stats)
    }
  }

  const toRegister: ReconciliationRegistration[] = []
  const skippedReserved: string[] = []
  const diagnostics: string[] = []

  const schemas = repo.propertySchemas
  const overrides = repo.propertyEditorOverrides

  for (const [name, stats] of sampler) {
    const inferredPreset = isRoamSemanticRefListProperty(name) ? 'refList' : classify(stats)
    const existingSchema = schemas.get(name)

    // Already registered — kernel, plugin, type-lifted, or pre-existing
    // user schema. The §3 hybrid rule wants vocabulary shared, so any
    // existing schema wins.
    if (existingSchema) {
      const diagnostic = schemaNearMissDiagnostic(name, stats, existingSchema.codec.type, 'existing')
      if (diagnostic) diagnostics.push(diagnostic)
      continue
    }

    // Reserved kernel-internal slot (per §6 collision rule).
    if (overrides.get(name)?.hidden === true) {
      skippedReserved.push(name)
      continue
    }

    const diagnostic = schemaNearMissDiagnostic(name, stats, inferredPreset, 'inferred')
    if (diagnostic) diagnostics.push(diagnostic)

    const targetTypes = inferredPreset === 'refList'
      ? inferRefListTargetTypes({
        total: stats.refListTokensTotal,
        dailyNote: stats.refListTokensDailyNote,
      })
      : undefined

    toRegister.push(
      targetTypes ? {name, presetId: inferredPreset, targetTypes} : {name, presetId: inferredPreset},
    )
  }

  return {toRegister, skippedReserved, diagnostics}
}

/** Apply phase: register every classified schema synchronously through
 *  `userSchemas.addSchema`. Each call persists a property-schema block
 *  under the workspace's Properties page AND adds the runtime
 *  contribution before content blocks are written. Failures are
 *  logged into `diagnostics` and the schema is skipped — content blocks
 *  whose property values use the missing schema fall through to the
 *  unknown-schema read fallback (per §9). */
export const applySchemaReconciliation = async (
  toRegister: ReadonlyArray<ReconciliationRegistration>,
  repo: Repo,
  diagnostics: string[],
): Promise<void> => {
  for (const entry of toRegister) {
    const {name, presetId} = entry
    const config = entry.targetTypes ? {targetTypes: entry.targetTypes} : undefined
    try {
      await repo.userSchemas.addSchema({name, presetId, config})
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      diagnostics.push(`Failed to register schema "${name}" (preset ${presetId}): ${message}`)
    }
  }
}

const jsonStringify = (value: unknown): string => {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}

/** String-schema normalization for mixed Roam attributes. Some Roam
 *  fields are scalar on most pages but multi-value arrays on a few
 *  pages (`email::` with child bullets, `Twitter::` with multiple
 *  accounts, etc.). When reconciliation chooses the string preset for
 *  that mixed field, preserve the non-string JSON shape as a JSON text
 *  value so the registered string codec can decode it. */
export const normalizeStringPropertyValues = (
  blocks: ReadonlyArray<BlockData>,
  stringPropertyNames: ReadonlySet<string>,
): void => {
  if (stringPropertyNames.size === 0) return
  for (const block of blocks) {
    if (!block.properties) continue
    for (const name of stringPropertyNames) {
      if (!(name in block.properties)) continue
      const raw = block.properties[name]
      if (typeof raw === 'string') continue
      block.properties[name] = jsonStringify(raw)
    }
  }
}

/** List-schema normalization for Roam attributes. Promotion emits a
 *  scalar for single `key:: value` occurrences and an array for
 *  repeated/child-list occurrences. When schema reconciliation picks
 *  the list preset, wrap the scalar cases so every stored value matches
 *  the list codec shape instead of being rejected on decode. */
export const normalizeListPropertyValues = (
  blocks: ReadonlyArray<BlockData>,
  listPropertyNames: ReadonlySet<string>,
): void => {
  if (listPropertyNames.size === 0) return
  for (const block of blocks) {
    if (!block.properties) continue
    for (const name of listPropertyNames) {
      if (!(name in block.properties)) continue
      const raw = block.properties[name]
      if (Array.isArray(raw)) continue
      block.properties[name] = [raw]
    }
  }
}

/** Token-→-id normalization for ref/refList-typed properties. Walks
 *  every planned block and, for each property whose name is in
 *  `refPropertyKinds`, converts `[[X]]` token strings/arrays into the
 *  shape the codec expects:
 *    - `'ref'`     → first resolved id (single string), or empty
 *                    string when nothing resolves.
 *    - `'refList'` → array of resolved ids (any order, drops
 *                    unresolved ones).
 *
 *  Without this pass the codec's `decode` would reject the raw token
 *  shape on first read. Tokens we can't resolve are reported through
 *  `diagnostics` so the user can fix dangling references later. */
export const normalizeRefPropertyValues = (
  blocks: ReadonlyArray<BlockData>,
  refPropertyKinds: ReadonlyMap<string, 'ref' | 'refList'>,
  aliasIdMap: ReadonlyMap<string, string>,
  diagnostics: string[],
): void => {
  if (refPropertyKinds.size === 0) return
  for (const block of blocks) {
    if (!block.properties) continue
    for (const [name, kind] of refPropertyKinds) {
      if (!(name in block.properties)) continue
      const raw = block.properties[name]
      const plainAliasMode = name === ROAM_PAGE_ALIAS_PROP ? 'conservative' : 'broad'
      const tokens = isRoamSemanticRefListProperty(name)
        ? collectAliasesFromRoamSemanticRefListValue(raw, plainAliasMode)
        : collectTokens(raw)
      if (tokens === null) continue

      const ids: string[] = []
      const dangling: string[] = []
      for (const alias of tokens) {
        const id = aliasIdMap.get(alias)
        if (id) ids.push(id)
        else dangling.push(alias)
      }
      if (dangling.length > 0) {
        diagnostics.push(
          `Block ${block.id}: ${kind} property "${name}" has unresolved aliases: ${dangling.join(', ')}`,
        )
      }
      if (kind === 'ref') {
        // Roam refs typically carry one alias; if a value happens to
        // hold multiple, take the first and report the rest. The
        // ref codec stores a single id; defaultValue '' represents
        // "no ref resolved".
        if (ids.length > 1) {
          diagnostics.push(
            `Block ${block.id}: ref property "${name}" had ${ids.length} aliases; keeping the first`,
          )
        }
        block.properties[name] = ids[0] ?? ''
      } else {
        block.properties[name] = ids
      }
    }
  }
}

const collectTokens = (raw: unknown): string[] | null => {
  if (typeof raw === 'string') {
    return parsePageTokenList(raw)?.map(token => token.alias) ?? null
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) return []
    if (!raw.every(item => typeof item === 'string')) return null
    const out: string[] = []
    for (const item of raw as string[]) {
      const tokens = parsePageTokenList(item)
      if (tokens) out.push(...tokens.map(token => token.alias))
    }
    return out
  }
  return null
}

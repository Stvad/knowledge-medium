/** Phase 4 of the Roam import: every imported `key:: value` attribute
 *  becomes a registered property schema instead of an unschemaed JSON
 *  blob. See user-defined-properties.md §8.
 *
 *  Classification rules (sampled across all planned blocks):
 *    - all values are `[[…]]` page tokens          → 'refList' preset
 *    - all values are finite numbers               → 'number' preset
 *    - all values are true/false                   → 'boolean' preset
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
  PAGE_TOKEN_RE,
  ROAM_PAGE_ALIAS_PROP,
  collectAliasesFromRoamSemanticRefListValue,
  explodePageTokens,
  isRoamSemanticRefListProperty,
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
}

const isPureTokenString = (value: string): boolean => {
  // explodePageTokens returns non-null only when the value is a pure
  // page-token list with at least 2 tokens. For single-token values
  // we still want to count it as "page-tokeny", so check separately.
  if (explodePageTokens(value) !== null) return true
  // Single token: `[[X]]` (with optional surrounding whitespace).
  const trimmed = value.trim()
  if (!trimmed.startsWith('[[') || !trimmed.endsWith(']]')) return false
  PAGE_TOKEN_RE.lastIndex = 0
  const match = PAGE_TOKEN_RE.exec(trimmed)
  return match !== null && match.index === 0 && match[0].length === trimmed.length
}

const recordSample = (stats: SampledNameStats, value: unknown): void => {
  stats.totalValues += 1
  if (typeof value === 'number' && Number.isFinite(value)) {
    stats.numbers += 1
    return
  }
  if (typeof value === 'boolean') {
    stats.booleans += 1
    return
  }
  if (typeof value === 'string' && isPureTokenString(value)) {
    stats.pageTokenStrings += 1
    return
  }
  if (Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')) {
    if (value.every(item => isPureTokenString(item as string))) {
      stats.pageTokenArrays += 1
    } else {
      stats.plainStringArrays += 1
    }
    return
  }
}

const classify = (stats: SampledNameStats): ClassifiedPresetId => {
  if (stats.totalValues === 0) return 'string'
  if (stats.numbers === stats.totalValues) return 'number'
  if (stats.booleans === stats.totalValues) return 'boolean'
  if (stats.pageTokenStrings + stats.pageTokenArrays === stats.totalValues) return 'refList'
  // Mixed plain-string arrays + scalar strings still degrade to 'string'
  // (the importer would have to stringify the arrays — out of scope).
  // Pure plain-string arrays land in the 'list' preset so the registered
  // codec can decode them.
  if (stats.plainStringArrays === stats.totalValues) return 'list'
  return 'string'
}

/** Plan-time reconciliation: collect every property name appearing on
 *  any planned block, skip kernel/plugin/already-registered names and
 *  hidden reserved slots, classify the rest by sampling values across
 *  the planned set, and produce a list of {name, presetId} pairs to
 *  register before the import writes content. */
export const collectSchemaReconciliationPlan = (
  blocks: ReadonlyArray<BlockData>,
  repo: Repo,
): {
  toRegister: ReadonlyArray<{name: string; presetId: ClassifiedPresetId}>
  skippedReserved: ReadonlyArray<string>
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
      }
      recordSample(stats, value)
      sampler.set(name, stats)
    }
  }

  const toRegister: Array<{name: string; presetId: ClassifiedPresetId}> = []
  const skippedReserved: string[] = []

  const schemas = repo.propertySchemas
  const overrides = repo.propertyEditorOverrides

  for (const [name, stats] of sampler) {
    // Already registered — kernel, plugin, type-lifted, or pre-existing
    // user schema. The §3 hybrid rule wants vocabulary shared, so any
    // existing schema wins.
    if (schemas.has(name)) continue

    // Reserved kernel-internal slot (per §6 collision rule).
    if (overrides.get(name)?.hidden === true) {
      skippedReserved.push(name)
      continue
    }

    toRegister.push({
      name,
      presetId: isRoamSemanticRefListProperty(name) ? 'refList' : classify(stats),
    })
  }

  return {toRegister, skippedReserved}
}

/** Apply phase: register every classified schema synchronously through
 *  `userSchemas.addSchema`. Each call persists a property-schema block
 *  under the workspace's Properties page AND adds the runtime
 *  contribution before content blocks are written. Failures are
 *  logged into `diagnostics` and the schema is skipped — content blocks
 *  whose property values use the missing schema fall through to the
 *  unknown-schema read fallback (per §9). */
export const applySchemaReconciliation = async (
  toRegister: ReadonlyArray<{name: string; presetId: ClassifiedPresetId}>,
  repo: Repo,
  diagnostics: string[],
): Promise<void> => {
  for (const {name, presetId} of toRegister) {
    try {
      await repo.userSchemas.addSchema({name, presetId})
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
    const exploded = explodePageTokens(raw)
    if (exploded !== null) {
      return exploded.map(stripBrackets).filter(Boolean) as string[]
    }
    const trimmed = raw.trim()
    if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
      const inner = trimmed.slice(2, -2).trim()
      return inner ? [inner] : null
    }
    return null
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) return []
    if (!raw.every(item => typeof item === 'string')) return null
    const out: string[] = []
    for (const item of raw as string[]) {
      const exploded = explodePageTokens(item)
      if (exploded !== null) {
        out.push(...exploded.map(stripBrackets).filter(Boolean))
        continue
      }
      const trimmed = item.trim()
      if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
        const inner = trimmed.slice(2, -2).trim()
        if (inner) out.push(inner)
      }
    }
    return out
  }
  return null
}

const stripBrackets = (value: string): string => {
  const trimmed = value.trim()
  return trimmed.startsWith('[[') && trimmed.endsWith(']]')
    ? trimmed.slice(2, -2).trim()
    : trimmed
}

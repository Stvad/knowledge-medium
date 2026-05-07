/** Phase 4 of the Roam import: every imported `key:: value` attribute
 *  becomes a registered property schema instead of an unschemaed JSON
 *  blob. See user-defined-properties.md §8.
 *
 *  v1 cut classifies into kernel primitive presets (string/number/
 *  boolean) only; refList — which §8.7 calls out as the ideal default
 *  for Roam attributes whose values are `[[…]]` page tokens — is
 *  deferred until token-→-id normalization lands. Until then a Roam
 *  attribute holding `[[Page]]` keeps its raw token-as-string and
 *  registers as a `'string'` preset, matching pre-Phase-4 behavior. */

import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'

interface SampledNameStats {
  totalValues: number
  numbers: number
  booleans: number
}

const recordSample = (stats: SampledNameStats, value: unknown): void => {
  stats.totalValues += 1
  if (typeof value === 'number' && Number.isFinite(value)) {
    stats.numbers += 1
  } else if (typeof value === 'boolean') {
    stats.booleans += 1
  }
}

const classify = (stats: SampledNameStats): 'number' | 'boolean' | 'string' => {
  if (stats.totalValues === 0) return 'string'
  if (stats.numbers === stats.totalValues) return 'number'
  if (stats.booleans === stats.totalValues) return 'boolean'
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
  toRegister: ReadonlyArray<{name: string; presetId: 'string' | 'number' | 'boolean'}>
  skippedReserved: ReadonlyArray<string>
} => {
  const sampler = new Map<string, SampledNameStats>()

  for (const block of blocks) {
    if (!block.properties) continue
    for (const [name, value] of Object.entries(block.properties)) {
      const stats = sampler.get(name) ?? {totalValues: 0, numbers: 0, booleans: 0}
      recordSample(stats, value)
      sampler.set(name, stats)
    }
  }

  const toRegister: Array<{name: string; presetId: 'string' | 'number' | 'boolean'}> = []
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

    toRegister.push({name, presetId: classify(stats)})
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
  toRegister: ReadonlyArray<{name: string; presetId: 'string' | 'number' | 'boolean'}>,
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

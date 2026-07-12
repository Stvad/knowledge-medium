import type {
  AnyJoinedValuePreset,
  AnyValuePreset,
  AnyValuePresetCore,
  AnyValuePresetPresentation,
} from '@/data/api'
import {joinValuePreset} from '@/data/api'
import type {FacetRuntime} from '@/facets/facet'
import {
  valuePresetCoresFacet,
  valuePresetPresentationsFacet,
  valuePresetsFacet,
} from './facets'

export interface ValuePresetRegistrySnapshot {
  readonly cores: ReadonlyMap<string, AnyValuePresetCore>
  readonly joined: ReadonlyMap<string, AnyJoinedValuePreset>
}

const compatibilityMirrors = new WeakSet<object>()

/** Mark a full preset published only to preserve direct reads of the old
 * joined facet. Canonical live joining ignores mirrors in favor of the split
 * core/presentation contributions. Genuine legacy plugin presets are unmarked
 * and retain their previous whole-preset override semantics. */
export const markValuePresetCompatibilityMirror = <T extends object>(
  preset: T,
): T => {
  compatibilityMirrors.add(preset)
  return preset
}

const cache = new WeakMap<FacetRuntime, {
  explicitCores: ReadonlyMap<string, AnyValuePresetCore>
  presentations: ReadonlyMap<string, AnyValuePresetPresentation>
  legacyPresets: ReadonlyMap<string, AnyValuePreset>
  snapshot: ValuePresetRegistrySnapshot
}>()

/** Derive one live core/presentation snapshot from the runtime.
 *
 * Full presets contributed through the pre-split `valuePresetsFacet` API keep
 * their historical whole-preset override semantics until removed. Generated
 * kernel compatibility mirrors are excluded from this canonical join, so
 * explicit core changes still update the presentation-only path live. */
export const readValuePresetRegistry = (runtime: FacetRuntime): ValuePresetRegistrySnapshot => {
  const explicitCores = runtime.read(valuePresetCoresFacet)
  const presentations = runtime.read(valuePresetPresentationsFacet)
  const legacyPresets = runtime.read(valuePresetsFacet)
  const previous = cache.get(runtime)
  if (
    previous?.explicitCores === explicitCores
    && previous.presentations === presentations
    && previous.legacyPresets === legacyPresets
  ) {
    return previous.snapshot
  }

  const cores = new Map<string, AnyValuePresetCore>()
  for (const [id, core] of explicitCores) cores.set(id, core)
  // A legacy full contribution retains its old whole-preset override
  // semantics until its author migrates to separate core/presentation facets.
  for (const [id, preset] of legacyPresets) {
    if (!compatibilityMirrors.has(preset)) cores.set(id, preset)
  }

  const joined = new Map<string, AnyJoinedValuePreset>()
  for (const [id, presentation] of presentations) {
    const core = cores.get(id)
    if (core) joined.set(id, joinValuePreset(core, presentation))
  }
  for (const [id, preset] of legacyPresets) {
    if (!compatibilityMirrors.has(preset)) joined.set(id, preset)
  }

  const snapshot = {cores, joined}
  cache.set(runtime, {explicitCores, presentations, legacyPresets, snapshot})
  return snapshot
}

export const readValuePresets = (
  runtime: FacetRuntime,
): ReadonlyMap<string, AnyJoinedValuePreset> => readValuePresetRegistry(runtime).joined

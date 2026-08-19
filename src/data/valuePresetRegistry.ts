import type {
  AnyJoinedValuePreset,
  AnyValuePresetCore,
  AnyValuePresetPresentation,
} from '@/data/api'
import {joinValuePreset} from '@/data/api'
import type {FacetRuntime} from '@/facets/facet'
import {
  valuePresetCoresFacet,
  valuePresetPresentationsFacet,
} from './facets'

export interface ValuePresetRegistrySnapshot {
  readonly cores: ReadonlyMap<string, AnyValuePresetCore>
  readonly joined: ReadonlyMap<string, AnyJoinedValuePreset>
}

const cache = new WeakMap<FacetRuntime, {
  cores: ReadonlyMap<string, AnyValuePresetCore>
  presentations: ReadonlyMap<string, AnyValuePresetPresentation>
  snapshot: ValuePresetRegistrySnapshot
}>()

/** Derive one live core/presentation snapshot from the runtime. Cores carry
 * behavior (codec/default/config); presentations join to them by id to add the
 * editor/glyph/label. A presentation with no matching core is dropped. */
export const readValuePresetRegistry = (runtime: FacetRuntime): ValuePresetRegistrySnapshot => {
  const cores = runtime.read(valuePresetCoresFacet)
  const presentations = runtime.read(valuePresetPresentationsFacet)
  const previous = cache.get(runtime)
  if (previous?.cores === cores && previous.presentations === presentations) {
    return previous.snapshot
  }

  const joined = new Map<string, AnyJoinedValuePreset>()
  for (const [id, presentation] of presentations) {
    const core = cores.get(id)
    if (core) joined.set(id, joinValuePreset(core, presentation))
  }

  const snapshot = {cores, joined}
  cache.set(runtime, {cores, presentations, snapshot})
  return snapshot
}

export const readValuePresets = (
  runtime: FacetRuntime,
): ReadonlyMap<string, AnyJoinedValuePreset> => readValuePresetRegistry(runtime).joined

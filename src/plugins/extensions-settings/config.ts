/**
 * Storage shape for the Extensions meta-plugin.
 *
 * One per-user prefs block (via `getPluginPrefsBlock`) holds the
 * `overrides` map for every togglable in the runtime. The codec
 * follows the standard "throw on shape mismatch" convention — the
 * subscription effect catches the throw and falls back to the empty
 * map, so a manual edit gone wrong doesn't take down extensions.
 */
import {
  ChangeScope,
  CodecError,
  defineBlockType,
  definePresetCore,
  seedProperty,
  type Codec,
} from '@/data/api'
import {
  decodeOverrides as decodeOverridesFromJson,
  encodeOverrides,
} from '@/extensions/overridesCache.js'
import type {Overrides} from '@/facets/togglable.js'

const expectedShape = 'object<string, boolean>'

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const decodeOverridesStrict = (json: unknown): Overrides => {
  // Absence at the property level never reaches `decode` (block.peekProperty
  // short-circuits on undefined). An explicit `null` we treat as "no
  // overrides" rather than throwing, to keep the storage friendly to manual
  // resets.
  if (json === null) return new Map()
  if (!isPlainObject(json)) {
    throw new CodecError(expectedShape, json)  }
  for (const value of Object.values(json)) {
    if (typeof value !== 'boolean') {
      throw new CodecError(expectedShape, json)    }
  }
  return decodeOverridesFromJson(json)
}

export const overridesCodec: Codec<Overrides> = {
  type: 'extensions:overrides',
  encode: encodeOverrides,
  decode: decodeOverridesStrict,
  // No `where` capability — we never `json_extract(... overrides ...) = ?`.
}

export const extensionsOverridesPresetCore = definePresetCore<Overrides>({
  id: overridesCodec.type,
  build: () => overridesCodec,
  defaultValue: new Map<string, boolean>(),
})

/** The overrides map property on the Extensions block. */
export const extensionsOverridesProp = seedProperty({
  seedKey: 'system:extensions-settings/property/overrides',
  revision: 1,
  name: 'extensions:overrides',
  preset: extensionsOverridesPresetCore,
  defaultValue: new Map<string, boolean>(),
  changeScope: ChangeScope.UserPrefs,
})

/** Per-user prefs sub-block type for the Extensions meta-plugin.
 *  Holds the central overrides map for every togglable. Lives under the
 *  Preferences tree via `getPluginPrefsBlock`. */
export const extensionsPrefsType = defineBlockType({
  id: 'extensions-prefs',
  label: 'Extensions',
  properties: [extensionsOverridesProp],
})

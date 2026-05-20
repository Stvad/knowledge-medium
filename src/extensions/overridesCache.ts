/**
 * First-paint cache for the runtime-toggle overrides map.
 *
 * `staticAppExtensions` resolves synchronously before PowerSync
 * hydrates, so without a cache every system plugin's effect would
 * start (and every mount would mount) only to be torn down ~one
 * round-trip later when the synced System Plugins block arrives. To
 * avoid the flash, we mirror the synced overrides into a narrowly-
 * scoped `ClientLocalSettings` entry per workspace, written from the
 * system-plugins meta-plugin's subscription effect, read by
 * `AppRuntimeProvider` at boot.
 *
 * Schema is sparse: only entries that diverge from the handle's
 * manifest default are recorded (matches `applyToggle` semantics).
 * Absence means "use the manifest default" — so adding new plugins
 * with `defaultEnabled: false` (opt-in / experimental) doesn't
 * require migrating anyone's cached state.
 */

import {clientLocalSettings, type ClientLocalSettings} from '@/utils/ClientLocalSettings.ts'
import type {Overrides} from '@/extensions/togglable.ts'

const CACHE_KEY_PREFIX = 'system-plugins.overrides'

const cacheKey = (workspaceId: string): string =>
  `${CACHE_KEY_PREFIX}.${workspaceId}`

/** Plain-object form for JSON storage. Map<id, boolean> flattens to
 *  `{[id]: boolean}`. */
export type OverridesEncoded = Record<string, boolean>

export const encodeOverrides = (overrides: Overrides): OverridesEncoded => {
  const out: OverridesEncoded = {}
  for (const [id, state] of overrides) out[id] = state
  return out
}

export const decodeOverrides = (raw: unknown): Overrides => {
  const out = new Map<string, boolean>()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, state] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof state === 'boolean') out.set(id, state)
  }
  return out
}

/** Read the cached overrides for a workspace. Returns an empty map
 *  if nothing is cached or the stored value is malformed (which
 *  matches "use manifest defaults"). */
export const readOverridesCache = (
  workspaceId: string,
  storage: ClientLocalSettings = clientLocalSettings,
): Overrides => {
  const raw = storage.get<unknown>(cacheKey(workspaceId), null)
  return decodeOverrides(raw)
}

/** Write the overrides map for a workspace. Called from the
 *  system-plugins effect whenever the synced block changes. Writes
 *  an empty object when the map has no entries (rather than removing
 *  the key) so consumers can distinguish "hydrated, no overrides"
 *  from "never hydrated, fall back to defaults" if they care. */
export const writeOverridesCache = (
  workspaceId: string,
  overrides: Overrides,
  storage: ClientLocalSettings = clientLocalSettings,
): void => {
  storage.set(cacheKey(workspaceId), encodeOverrides(overrides))
}

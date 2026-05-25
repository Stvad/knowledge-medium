/**
 * First-paint cache for the user's keybinding overrides.
 *
 * Mirrors the canonical per-user prefs block into a workspace-scoped
 * localStorage entry so `staticAppExtensions`-resolution sees the
 * user's chosen bindings on cold load without waiting for PowerSync
 * to hydrate. Matches the pattern used by `extensions-settings` for
 * its overrides map (see `src/extensions/overridesCache.ts`).
 *
 * Written by the subscription effect after the prefs block changes;
 * read by the `keybindingOverridesContribution` AppExtension function
 * each time the runtime is built.
 */
import {clientLocalSettings, type ClientLocalSettings} from '@/utils/ClientLocalSettings.js'
import type {StoredKeybindingOverrides} from './config.ts'

const CACHE_KEY_PREFIX = 'keybindings.user-overrides'

const cacheKey = (workspaceId: string): string =>
  `${CACHE_KEY_PREFIX}.${workspaceId}`

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isCachedOverride = (value: unknown): boolean => {
  if (!isPlainObject(value)) return false
  if (typeof value.actionId !== 'string' || value.actionId.length === 0) return false
  if (typeof value.context !== 'string' || value.context.length === 0) return false
  if (!isPlainObject(value.binding)) return false
  if ('unbound' in value.binding) return value.binding.unbound === true
  if ('keys' in value.binding) {
    return typeof value.binding.keys === 'string'
      || (Array.isArray(value.binding.keys) && value.binding.keys.every(item => typeof item === 'string'))
  }
  return false
}

export const readKeybindingOverridesCache = (
  workspaceId: string,
  storage: ClientLocalSettings = clientLocalSettings,
): StoredKeybindingOverrides => {
  const raw = storage.get<unknown>(cacheKey(workspaceId), null)
  if (!Array.isArray(raw)) return []
  return raw.filter(isCachedOverride) as StoredKeybindingOverrides
}

export const writeKeybindingOverridesCache = (
  workspaceId: string,
  overrides: StoredKeybindingOverrides,
  storage: ClientLocalSettings = clientLocalSettings,
): void => {
  storage.set(cacheKey(workspaceId), overrides)
}

export const sameOverrides = (
  a: StoredKeybindingOverrides,
  b: StoredKeybindingOverrides,
): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.actionId !== y.actionId) return false
    if (x.context !== y.context) return false
    if ('unbound' in x.binding) {
      if (!('unbound' in y.binding)) return false
    } else if ('unbound' in y.binding) {
      return false
    } else {
      const xs = Array.isArray(x.binding.keys) ? x.binding.keys.join('') : x.binding.keys
      const ys = Array.isArray(y.binding.keys) ? y.binding.keys.join('') : y.binding.keys
      if (xs !== ys) return false
    }
  }
  return true
}

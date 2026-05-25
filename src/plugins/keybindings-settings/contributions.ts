/**
 * Builds `keybindingOverridesFacet` contributions from the per-user
 * cache. Called from `AppRuntimeProvider` so the contributions can be
 * merged into the static extension tree at first-paint via the
 * synchronous `resolveAppRuntimeSync` path — function-valued
 * AppExtensions aren't permitted there, so we do the cache read at
 * the React layer and pass the resulting contributions in.
 *
 * Precedence is 100 so user-prefs entries trump any plugin-shipped
 * overrides (which default to 0). The `applyKeybindingOverrides` pass
 * sorts entries ascending by precedence and treats "last wins" as the
 * resolution rule, so this lines up cleanly.
 */
import type {AppExtension} from '@/extensions/facet.js'
import {
  KEYBINDING_OVERRIDE_USER_SOURCE,
  keybindingOverridesFacet,
} from '@/shortcuts/keybindingOverrides.js'
import {readKeybindingOverridesCache} from './overridesCache.ts'

const USER_PREFS_PRECEDENCE = 100

export const buildUserKeybindingContributions = (
  workspaceId: string | null | undefined,
): readonly AppExtension[] => {
  if (!workspaceId) return []
  const cached = readKeybindingOverridesCache(workspaceId)
  return cached.map(entry => keybindingOverridesFacet.of({
    actionId: entry.actionId,
    context: entry.context,
    binding: entry.binding,
    source: KEYBINDING_OVERRIDE_USER_SOURCE,
  }, {
    source: KEYBINDING_OVERRIDE_USER_SOURCE,
    precedence: USER_PREFS_PRECEDENCE,
  }))
}

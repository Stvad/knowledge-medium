/**
 * Persist the overrides map to the System Plugins prefs block.
 *
 * Thin I/O wrapper: resolves the block via `getPluginPrefsBlock` (the
 * memoised idempotent helper used everywhere a plugin owns a prefs
 * sub-block) and writes the encoded overrides through `tx.setProperty`,
 * scoped `UserPrefs` so it syncs across devices.
 *
 * The subscription effect in `effect.ts` picks up the write, mirrors
 * it into the localStorage cache, and dispatches
 * `refreshAppRuntime` — so callers don't have to dispatch refresh
 * themselves.
 */

import {ChangeScope} from '@/data/api'
import type {Repo} from '@/data/repo'
import {getPluginPrefsBlock} from '@/data/stateBlocks.ts'
import type {Overrides} from '@/extensions/togglable.ts'
import {
  systemPluginOverridesProp,
  systemPluginsPrefsType,
} from './config.ts'

export const writeOverridesToBlock = async (
  repo: Repo,
  workspaceId: string,
  nextOverrides: Overrides,
): Promise<void> => {
  const prefsBlock = await getPluginPrefsBlock(
    repo,
    workspaceId,
    repo.user,
    systemPluginsPrefsType,
  )
  await repo.tx(
    async (tx) => {
      await tx.setProperty(
        prefsBlock.id,
        systemPluginOverridesProp,
        nextOverrides,
      )
    },
    {
      scope: ChangeScope.UserPrefs,
      description: 'system-plugins: update overrides',
    },
  )
}

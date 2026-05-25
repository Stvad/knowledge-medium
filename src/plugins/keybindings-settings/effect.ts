/**
 * Subscribes to the keybindings prefs block, mirrors each change
 * into the localStorage cache, and dispatches `refreshAppRuntime`
 * whenever the synced overrides diverge from the cached snapshot.
 *
 * Same shape as `extensions-settings/effect.ts` — the canonical
 * state lives in the synced block; the cache is a first-paint
 * mirror. Codec failures are caught here so a malformed snapshot
 * falls back to "no overrides" rather than locking the user out.
 */
import type {AppEffect} from '@/extensions/core.js'
import {getPluginPrefsBlock} from '@/data/stateBlocks.js'
import {refreshAppRuntime} from '@/extensions/runtimeEvents.js'
import type {PropertySchema} from '@/data/api'
import {
  keybindingOverridesProp,
  keybindingsPrefsType,
  type StoredKeybindingOverrides,
} from './config.ts'
import {
  readKeybindingOverridesCache,
  sameOverrides,
  writeKeybindingOverridesCache,
} from './overridesCache.ts'

interface OverridesReadable {
  peekProperty<T>(schema: PropertySchema<T>): T | undefined
}

export const readOverridesFromBlock = (block: OverridesReadable): StoredKeybindingOverrides => {
  try {
    return block.peekProperty(keybindingOverridesProp) ?? []
  } catch (error) {
    console.error(
      'Keybindings: overrides property is malformed; ' +
      'falling back to "no overrides". Repair via settings or manually edit ' +
      'the Keyboard shortcuts block.',
      error,
    )
    return []
  }
}

export const reconcileOverrides = (
  workspaceId: string,
  block: OverridesReadable,
  dispatchRefresh: () => void = refreshAppRuntime,
): boolean => {
  const next = readOverridesFromBlock(block)
  const cached = readKeybindingOverridesCache(workspaceId)
  if (sameOverrides(next, cached)) return false
  writeKeybindingOverridesCache(workspaceId, next)
  dispatchRefresh()
  return true
}

export const keybindingsSyncEffect: AppEffect = {
  id: 'keybindings.sync-cache',
  start: ({repo, workspaceId}) => {
    let disposed = false
    let unsubscribe: (() => void) | undefined

    void (async () => {
      const block = await getPluginPrefsBlock(
        repo,
        workspaceId,
        repo.user,
        keybindingsPrefsType,
      )
      if (disposed) return

      const reconcile = () => reconcileOverrides(workspaceId, block)
      reconcile()
      unsubscribe = block.subscribe(reconcile)
    })().catch(error => {
      console.error(
        'Keybindings: failed to resolve prefs block; ' +
        'overrides will not sync until next session.',
        error,
      )
    })

    return () => {
      disposed = true
      unsubscribe?.()
    }
  },
}

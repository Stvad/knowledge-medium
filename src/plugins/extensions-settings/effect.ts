/**
 * Extensions subscription effect.
 *
 * Resolves the per-user Extensions prefs block, processes its
 * current overrides snapshot, then subscribes to future mutations.
 * Whenever the canonical map diverges from the cached one, the effect
 * writes the cache and dispatches `refreshAppRuntime` so
 * AppRuntimeProvider re-resolves with the fresh state.
 *
 * Codec failures (malformed property shape) are caught here — the
 * fallback is "no overrides" so extensions keep working while
 * the surfaced error can be repaired through the settings UI.
 */
import type {AppEffect} from '@/extensions/core.js'
import {getPluginPrefsBlock} from '@/data/stateBlocks.js'
import type {PropertySchema} from '@/data/api'
import {
  readOverridesCache,
  writeOverridesCache,
} from '@/extensions/overridesCache.js'
import {refreshAppRuntime} from '@/facets/runtimeEvents.js'
import type {Overrides} from '@/facets/togglable.js'
import {
  extensionsOverridesProp,
  extensionsPrefsType,
} from './config.ts'

export const overridesEqual = (a: Overrides, b: Overrides): boolean => {
  if (a.size !== b.size) return false
  for (const [id, state] of a) if (b.get(id) !== state) return false
  return true
}

/** Minimal Block contract we need — typed loosely so tests can stub
 *  without constructing a full Repo. */
interface OverridesReadable {
  peekProperty<T>(schema: PropertySchema<T>): T | undefined
}

/** Read the overrides map from a Block snapshot. Returns an empty map
 *  on codec failure (malformed property) and logs the error rather
 *  than letting it bubble — taking down extensions because the
 *  config block is corrupt would defeat the purpose of having a
 *  toggle system. */
export const readOverridesFromBlock = (
  block: OverridesReadable,
): Overrides => {
  try {
    return block.peekProperty(extensionsOverridesProp) ?? new Map()
  } catch (error) {
    console.error(
      'Extensions: overrides property is malformed; ' +
      'falling back to no overrides. Repair via settings or manually edit ' +
      'the Extensions block.',
      error,
    )
    return new Map()
  }
}

/** Pure reconcile step — compares the block's overrides against the
 *  cached map, writes + dispatches refresh when they differ.
 *  Extracted so tests can drive it without constructing a Block /
 *  Repo. Returns `true` when a refresh was dispatched. */
export const reconcileOverrides = (
  workspaceId: string,
  block: OverridesReadable,
  dispatchRefresh: () => void = refreshAppRuntime,
): boolean => {
  const next = readOverridesFromBlock(block)
  const cached = readOverridesCache(workspaceId)
  if (overridesEqual(next, cached)) return false
  writeOverridesCache(workspaceId, next)
  dispatchRefresh()
  return true
}

export const extensionsSyncEffect: AppEffect = {
  id: 'extensions.sync-cache',
  start: ({repo, workspaceId}) => {
    let disposed = false
    let unsubscribe: (() => void) | undefined

    void (async () => {
      const block = await getPluginPrefsBlock(
        repo,
        workspaceId,
        repo.user,
        extensionsPrefsType,
      )
      if (disposed) return

      // block.subscribe only fires on subsequent mutations, so we
      // explicitly reconcile the current snapshot once before
      // subscribing.
      const reconcile = () => reconcileOverrides(workspaceId, block)
      reconcile()
      unsubscribe = block.subscribe(reconcile)
    })().catch(error => {
      console.error(
        'Extensions: failed to resolve prefs block; ' +
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

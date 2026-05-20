/**
 * One-shot legacy-disable migration.
 *
 * Before the unified overrides map, user extensions stored their
 * "disabled" state on each extension block via
 * `extensionDisabledProp` ("system:disabled"). The runtime now reads
 * the overrides map exclusively; this effect folds any surviving
 * legacy state into the new shape at startup.
 *
 * Idempotent: once a block's legacy prop has been cleared, re-runs
 * find nothing to migrate. Failures are swallowed (logged) — a
 * migration error must not block app startup, since the loader can
 * still function from overrides alone for any block that doesn't have
 * legacy state.
 *
 * No back-compat shim — alpha. The legacy property is removed in a
 * follow-up slice once we're confident migration has run for all
 * active workspaces.
 */

import {ChangeScope} from '@/data/api'
import type {BlockData} from '@/data/api'
import {extensionDisabledProp} from '@/data/properties.ts'
import {getPluginPrefsBlock} from '@/data/stateBlocks.ts'
import type {AppEffect} from '@/extensions/core.ts'
import type {Overrides} from '@/extensions/togglable.ts'
import {scheduleIdle} from '@/utils/scheduleIdle.ts'
import {
  systemPluginOverridesProp,
  systemPluginsPrefsType,
} from './config.ts'

/** Pure shape for the migration step. Inputs: the legacy state held
 *  on extension blocks + the current overrides map. Output: the
 *  merged overrides + the list of blocks whose legacy flag should be
 *  cleared. Extracted so the merging behaviour is unit-testable
 *  without standing up a Repo. */
export interface MigrationInput {
  extensionBlocks: readonly BlockData[]
  currentOverrides: Overrides
}

export interface MigrationOutput {
  /** New overrides map with one `false` entry per legacy-disabled block,
   *  preserving existing entries. */
  nextOverrides: Overrides
  /** Blocks whose `extensionDisabledProp === true` flag should be
   *  cleared. Empty array if there's nothing to migrate. */
  blocksToClear: readonly BlockData[]
}

export const computeLegacyDisableMigration = (
  input: MigrationInput,
): MigrationOutput => {
  const legacy = input.extensionBlocks.filter(
    (b) => b.properties[extensionDisabledProp.name] === true,
  )
  if (legacy.length === 0) {
    return {nextOverrides: input.currentOverrides, blocksToClear: []}
  }
  const next = new Map<string, boolean>(input.currentOverrides)
  for (const block of legacy) next.set(block.id, false)
  return {nextOverrides: next, blocksToClear: legacy}
}

const recordedMigrations = new Map<string, Promise<void>>()

const migrationKey = (workspaceId: string, userId: string): string =>
  `${workspaceId}:${userId}`

/** Runs the migration against a real Repo. Wraps
 *  `computeLegacyDisableMigration` with the I/O and tx plumbing. */
export const runLegacyDisableMigration = async (
  repo: Parameters<AppEffect['start']>[0]['repo'],
  workspaceId: string,
): Promise<void> => {
  try {
    const blocks = await repo.query.findExtensionBlocks({workspaceId}).load()
    const prefsBlock = await getPluginPrefsBlock(
      repo,
      workspaceId,
      repo.user,
      systemPluginsPrefsType,
    )
    const currentOverrides: Overrides =
      prefsBlock.peekProperty(systemPluginOverridesProp) ?? new Map()

    const {nextOverrides, blocksToClear} = computeLegacyDisableMigration({
      extensionBlocks: blocks,
      currentOverrides,
    })
    if (blocksToClear.length === 0) return

    await repo.tx(
      async (tx) => {
        await tx.setProperty(prefsBlock.id, systemPluginOverridesProp, nextOverrides)
        for (const block of blocksToClear) {
          // Clearing the legacy flag is what makes this effect
          // idempotent — at next startup no block matches the filter
          // so the migration is a no-op.
          await tx.setProperty(block.id, extensionDisabledProp, false)
        }
      },
      {
        scope: ChangeScope.UserPrefs,
        description:
          'system-plugins: migrate legacy extensionDisabled to overrides',
      },
    )

    console.info(
      `System Plugins: migrated ${blocksToClear.length} legacy ` +
      `extensionDisabled flag(s) into the overrides map.`,
    )
  } catch (error) {
    // Swallow — migration failure must not break app startup. The
    // loader still works from overrides alone for any block that
    // doesn't have legacy state.
    console.error(
      'System Plugins: legacy disable migration failed',
      error,
    )
  }
}

export const legacyDisableMigrationEffect: AppEffect = {
  id: 'system-plugins.legacy-disable-migration',
  start: ({repo, workspaceId}) => {
    const key = migrationKey(workspaceId, repo.user.id)
    if (recordedMigrations.has(key)) return
    // Run on idle so the migration doesn't compete with the cold-start
    // critical path. Tracking the promise in `recordedMigrations`
    // makes the once-per-(workspace,user) guard survive a remount.
    let resolve!: () => void
    const sentinel = new Promise<void>((r) => { resolve = r })
    recordedMigrations.set(key, sentinel)
    scheduleIdle(() => {
      void runLegacyDisableMigration(repo, workspaceId).finally(resolve)
    })
  },
}

/** Test seam: reset the once-per-workspace guard. */
export const __resetMigrationGuardForTest = (): void => {
  recordedMigrations.clear()
}

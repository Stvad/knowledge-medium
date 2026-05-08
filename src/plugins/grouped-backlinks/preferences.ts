import { getUserPrefsBlock } from '@/data/globalState.ts'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo'
import type { AppEffect } from '@/extensions/core.ts'
import { scheduleIdle } from '@/utils/scheduleIdle.ts'
import {
  groupedBacklinksDefaultsProp,
  INITIAL_GROUPED_BACKLINKS_CONFIG,
} from './config.ts'

const initialized = new Map<string, Promise<void>>()

export const initializeGroupedBacklinksPreferences = async (
  repo: Repo,
  workspaceId: string,
): Promise<void> => {
  const key = `${repo.instanceId}:${workspaceId}:${repo.user.id}`
  const existing = initialized.get(key)
  if (existing) return existing

  const init = (async () => {
    const prefsBlock = await getUserPrefsBlock(repo, workspaceId, repo.user)
    // Fast path: skip the writeTransaction entirely when the
    // preference value is already present (every cold start after the
    // first). The pre-existing inside-tx check returned no-op but had
    // already paid the writeTransaction cost.
    if (prefsBlock.peekProperty(groupedBacklinksDefaultsProp) !== undefined) return

    await repo.tx(async tx => {
      const current = await tx.get(prefsBlock.id)
      if (!current || current.properties[groupedBacklinksDefaultsProp.name] !== undefined) {
        return
      }
      await tx.setProperty(
        prefsBlock.id,
        groupedBacklinksDefaultsProp,
        INITIAL_GROUPED_BACKLINKS_CONFIG,
      )
    }, {
      scope: ChangeScope.UserPrefs,
      description: 'initialize grouped backlinks preferences',
    })
  })().catch(error => {
    initialized.delete(key)
    throw error
  })

  initialized.set(key, init)
  return init
}

export const groupedBacklinksPreferencesEffect: AppEffect = {
  id: 'grouped-backlinks.preferences',
  // Defer off the cold-start critical path — preferences only need to
  // be set once ever; subsequent loads short-circuit through the fast
  // path above. Even the first-ever run can wait until after first
  // paint without affecting correctness (consumers fall back to the
  // schema's defaultValue until the bucket's persistent value lands).
  start: ({repo, workspaceId}) => {
    scheduleIdle(() => {
      void initializeGroupedBacklinksPreferences(repo, workspaceId)
    })
  },
}

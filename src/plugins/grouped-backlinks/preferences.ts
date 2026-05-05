import { getUserPrefsBlock } from '@/data/globalState.ts'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo'
import type { AppEffect } from '@/extensions/core.ts'
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
  start: ({repo, workspaceId}) => initializeGroupedBacklinksPreferences(repo, workspaceId),
}

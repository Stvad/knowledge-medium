import { getUserPrefsBlock } from '@/data/globalState.ts'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo'
import type { AppEffect } from '@/extensions/core.ts'
import { scheduleIdle } from '@/utils/scheduleIdle.ts'
import {
  INITIAL_DAILY_NOTE_BACKLINKS_DEFAULTS,
  dailyNoteBacklinksDefaultsProp,
} from './dailyNoteDefaults.ts'

const initialized = new Map<string, Promise<void>>()

export const initializeDailyNoteBacklinksPreferences = async (
  repo: Repo,
  workspaceId: string,
): Promise<void> => {
  const key = `${repo.instanceId}:${workspaceId}:${repo.user.id}`
  const existing = initialized.get(key)
  if (existing) return existing

  const init = (async () => {
    const prefsBlock = await getUserPrefsBlock(repo, workspaceId, repo.user)
    if (prefsBlock.peekProperty(dailyNoteBacklinksDefaultsProp) !== undefined) return

    await repo.tx(async tx => {
      const current = await tx.get(prefsBlock.id)
      if (!current || current.properties[dailyNoteBacklinksDefaultsProp.name] !== undefined) {
        return
      }
      await tx.setProperty(
        prefsBlock.id,
        dailyNoteBacklinksDefaultsProp,
        INITIAL_DAILY_NOTE_BACKLINKS_DEFAULTS,
      )
    }, {
      scope: ChangeScope.UserPrefs,
      description: 'initialize daily note backlinks preferences',
    })
  })().catch(error => {
    initialized.delete(key)
    throw error
  })

  initialized.set(key, init)
  return init
}

export const dailyNoteBacklinksPreferencesEffect: AppEffect = {
  id: 'backlinks.daily-note-preferences',
  start: ({repo, workspaceId}) => {
    scheduleIdle(() => {
      void initializeDailyNoteBacklinksPreferences(repo, workspaceId)
    })
  },
}

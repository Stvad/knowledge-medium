import { getUserPrefsBlock } from '@/data/globalState.ts'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo'
import type { AppEffect } from '@/extensions/core.ts'
import { backlinksViewProp, DEFAULT_BACKLINKS_VIEW_ID } from './prop.ts'

const initialized = new Map<string, Promise<void>>()

/** Mirror of `groupedBacklinksPreferencesEffect`'s init pattern: write
 *  the schema's default into UserPrefs the first time we see this
 *  (workspace, user) pair. Without this, `useUserPrefsProperty` would
 *  return the schema default but no subscriber would fire when the
 *  user later sets a real value — there'd be nothing to invalidate. */
export const initializeBacklinksViewPreferences = async (
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
      if (!current || current.properties[backlinksViewProp.name] !== undefined) return
      await tx.setProperty(prefsBlock.id, backlinksViewProp, DEFAULT_BACKLINKS_VIEW_ID)
    }, {
      scope: ChangeScope.UserPrefs,
      description: 'initialize backlinks view preference',
    })
  })().catch(error => {
    initialized.delete(key)
    throw error
  })

  initialized.set(key, init)
  return init
}

export const backlinksViewPreferencesEffect: AppEffect = {
  id: 'backlinks-view.preferences',
  start: ({repo, workspaceId}) => initializeBacklinksViewPreferences(repo, workspaceId),
}

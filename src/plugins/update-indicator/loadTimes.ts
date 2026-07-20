import { getPluginPrefsBlock } from '@/data/stateBlocks.js'
import {
  ChangeScope,
  seedType,
  seedProperty,
} from '@/data/api'
import type { Repo } from '@/data/repo'
import type { AppEffect } from '@/extensions/core.js'
import { scheduleDeepIdle, LAZY_DEEP_IDLE } from '@/utils/scheduleIdle.js'

export const previousLoadTimeProp = seedProperty({
  seedKey: 'system:update-indicator/property/previous-load-time',
  revision: 1,
  name: 'previousLoadTime',
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.UserPrefs,
})

export const currentLoadTimeProp = seedProperty({
  seedKey: 'system:update-indicator/property/current-load-time',
  revision: 1,
  name: 'currentLoadTime',
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.UserPrefs,
})

/** Per-plugin prefs sub-block for the update-indicator plugin. Records
 *  the previous/current bundle-load timestamps so the indicator can tell
 *  the user "a new build is live since you last loaded." */
export const updateIndicatorPrefsType = seedType({
  seedKey: 'system:update-indicator/type/update-indicator-prefs',
  revision: 1,
  id: 'update-indicator-prefs',
  label: 'Update indicator',
  properties: [previousLoadTimeProp, currentLoadTimeProp],
})

const recordedLoadTimes = new Map<string, Promise<void>>()

export const recordUpdateIndicatorLoadTime = async (
  repo: Repo,
  workspaceId: string,
): Promise<void> => {
  const key = `${repo.instanceId}:${workspaceId}:${repo.user.id}`
  const existing = recordedLoadTimes.get(key)
  if (existing) return existing

  const record = (async () => {
    const prefsBlock = await getPluginPrefsBlock(repo, workspaceId, repo.user, updateIndicatorPrefsType)
    const previous = prefsBlock.peekProperty(currentLoadTimeProp) ?? 0

    await repo.tx(async tx => {
      await tx.setProperty(prefsBlock.id, previousLoadTimeProp, previous)
      await tx.setProperty(prefsBlock.id, currentLoadTimeProp, Date.now())
    }, {scope: ChangeScope.UserPrefs, description: 'update indicator load time'})
  })().catch(error => {
    recordedLoadTimes.delete(key)
    throw error
  })

  recordedLoadTimes.set(key, record)
  return record
}

/** Schedule the load-time write off the cold-start critical path.
 *  The indicator only needs to know "when did *the previous* load
 *  finish" — it doesn't need to write *this* load's timestamp before
 *  any rendering, just before the next reload. So pushing the SQL to
 *  deep idle is correctness-preserving and removes the writeTransaction
 *  + its `getUserPrefsBlock` ensure-tx from the bootstrap window. The
 *  next-reload deadline is far off, so genuine idle (never near boot,
 *  fine to skip a never-idle session) is the right cadence. */
export const updateIndicatorLoadTimeEffect: AppEffect = {
  id: 'update-indicator.load-time',
  start: ({repo, workspaceId}) => {
    scheduleDeepIdle(() => {
      void recordUpdateIndicatorLoadTime(repo, workspaceId)
    }, LAZY_DEEP_IDLE)
  },
}

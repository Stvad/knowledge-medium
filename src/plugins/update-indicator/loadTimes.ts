import { getPluginPrefsBlock } from '@/data/stateBlocks.ts'
import {
  ChangeScope,
  codecs,
  defineBlockType,
  defineProperty,
} from '@/data/api'
import type { Repo } from '@/data/repo'
import type { AppEffect } from '@/extensions/core.ts'
import { scheduleIdle } from '@/utils/scheduleIdle.ts'

export const previousLoadTimeProp = defineProperty<number | undefined>('previousLoadTime', {
  codec: codecs.optionalNumber,
  defaultValue: undefined,
  changeScope: ChangeScope.UserPrefs,
})

export const currentLoadTimeProp = defineProperty<number | undefined>('currentLoadTime', {
  codec: codecs.optionalNumber,
  defaultValue: undefined,
  changeScope: ChangeScope.UserPrefs,
})

/** Per-plugin prefs sub-block for the update-indicator plugin. Records
 *  the previous/current bundle-load timestamps so the indicator can tell
 *  the user "a new build is live since you last loaded." */
export const updateIndicatorPrefsType = defineBlockType({
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
 *  idle time is correctness-preserving and removes the writeTransaction
 *  + its `getUserPrefsBlock` ensure-tx from the bootstrap window. */
export const updateIndicatorLoadTimeEffect: AppEffect = {
  id: 'update-indicator.load-time',
  start: ({repo, workspaceId}) => {
    scheduleIdle(() => {
      void recordUpdateIndicatorLoadTime(repo, workspaceId)
    })
  },
}

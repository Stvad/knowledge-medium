import { getUserPrefsBlock } from '@/data/globalState.ts'
import {
  ChangeScope,
  CodecError,
  defineProperty,
  type Codec,
} from '@/data/api'
import type { Repo } from '@/data/repo'
import type { AppEffect } from '@/extensions/core.ts'

/** Absence-aware number codec — value type is `number | undefined`,
 *  null on the wire for unset. Defined inline (no codecs.optional
 *  wrapper exists in v1; each absence-aware codec declares its
 *  null-handling explicitly). */
const optionalLoadTimeCodec: Codec<number | undefined> = {
  type: 'number',
  encode: v => (v === undefined ? null : v),
  decode: j => {
    if (j === null || j === undefined) return undefined
    if (typeof j !== 'number' || !Number.isFinite(j)) throw new CodecError('finite number', j)
    return j
  },
  where: {
    encode: v => {
      if (v === undefined) throw new CodecError('number (use null for unset)', v)
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new CodecError('finite number', v)
      return v
    },
  },
}

export const previousLoadTimeProp = defineProperty<number | undefined>('previousLoadTime', {
  codec: optionalLoadTimeCodec,
  defaultValue: undefined,
  changeScope: ChangeScope.UserPrefs,
})

export const currentLoadTimeProp = defineProperty<number | undefined>('currentLoadTime', {
  codec: optionalLoadTimeCodec,
  defaultValue: undefined,
  changeScope: ChangeScope.UserPrefs,
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
    const prefsBlock = await getUserPrefsBlock(repo, workspaceId, repo.user)
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

export const updateIndicatorLoadTimeEffect: AppEffect = {
  id: 'update-indicator.load-time',
  start: ({repo, workspaceId}) => recordUpdateIndicatorLoadTime(repo, workspaceId),
}

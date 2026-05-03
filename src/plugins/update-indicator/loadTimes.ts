import { getUserBlock } from '@/data/globalState.ts'
import {
  ChangeScope,
  codecs,
  defineProperty,
} from '@/data/api'
import type { Repo } from '@/data/repo'
import type { AppEffect } from '@/extensions/core.ts'

export const previousLoadTimeProp = defineProperty<number | undefined>('previousLoadTime', {
  codec: codecs.optional(codecs.number),
  defaultValue: undefined,
  changeScope: ChangeScope.UiState,
  kind: 'number',
})

export const currentLoadTimeProp = defineProperty<number | undefined>('currentLoadTime', {
  codec: codecs.optional(codecs.number),
  defaultValue: undefined,
  changeScope: ChangeScope.UiState,
  kind: 'number',
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
    const userBlock = await getUserBlock(repo, workspaceId, repo.user)
    const previous = userBlock.peekProperty(currentLoadTimeProp) ?? 0

    await repo.tx(async tx => {
      await tx.setProperty(userBlock.id, previousLoadTimeProp, previous)
      await tx.setProperty(userBlock.id, currentLoadTimeProp, Date.now())
    }, {scope: ChangeScope.UiState, description: 'update indicator load time'})
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

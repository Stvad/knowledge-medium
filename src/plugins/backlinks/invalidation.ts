import type {
  ChangeSnapshot,
  InvalidationRule,
  PluginInvalidationEmit,
} from '@/data/invalidation.ts'

export const BACKLINKS_TARGET_INVALIDATION_CHANNEL = 'backlinks.target'

const emitReferenceTargetDiff = (
  before: ReadonlyArray<{id: string}>,
  after: ReadonlyArray<{id: string}>,
  emit: PluginInvalidationEmit,
): void => {
  if (before.length === 0 && after.length === 0) return

  const beforeIds = new Set<string>()
  for (const ref of before) beforeIds.add(ref.id)

  const afterIds = new Set<string>()
  for (const ref of after) afterIds.add(ref.id)

  for (const id of beforeIds) {
    if (!afterIds.has(id)) emit(BACKLINKS_TARGET_INVALIDATION_CHANNEL, id)
  }
  for (const id of afterIds) {
    if (!beforeIds.has(id)) emit(BACKLINKS_TARGET_INVALIDATION_CHANNEL, id)
  }
}

const emitSnapshotTargetDiff = (
  snapshot: ChangeSnapshot,
  emit: PluginInvalidationEmit,
): void => {
  const beforeLive = !!snapshot.before && !snapshot.before.deleted
  const afterLive = !!snapshot.after && !snapshot.after.deleted
  const beforeRefs = beforeLive ? snapshot.before?.references ?? [] : []
  const afterRefs = afterLive ? snapshot.after?.references ?? [] : []
  emitReferenceTargetDiff(beforeRefs, afterRefs, emit)
}

export const backlinksInvalidationRule: InvalidationRule = {
  id: 'backlinks.references-invalidation',
  collectFromSnapshots: (snapshots, emit) => {
    for (const snapshot of snapshots.values()) {
      emitSnapshotTargetDiff(snapshot, emit)
    }
  },
  collectFromRowEvent: ({before, after}, emit) => {
    const beforeLive = !!before && !before.deleted
    const afterLive = !!after && !after.deleted
    const beforeRefs = beforeLive ? before?.references ?? [] : []
    const afterRefs = afterLive ? after?.references ?? [] : []
    emitReferenceTargetDiff(beforeRefs, afterRefs, emit)
  },
}

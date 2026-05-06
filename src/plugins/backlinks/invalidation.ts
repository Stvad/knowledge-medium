import type {
  ChangeSnapshot,
  InvalidationRule,
  PluginInvalidationEmit,
} from '@/data/invalidation.ts'

export const BACKLINKS_TARGET_INVALIDATION_CHANNEL = 'backlinks.target'

const emitReferenceTargetDiff = (
  before: ReadonlyArray<{id: string; sourceField?: string}>,
  after: ReadonlyArray<{id: string; sourceField?: string}>,
  emit: PluginInvalidationEmit,
): void => {
  if (before.length === 0 && after.length === 0) return

  const beforePairs = new Map<string, string>()
  for (const ref of before) {
    beforePairs.set(`${ref.id}\u0000${ref.sourceField ?? ''}`, ref.id)
  }

  const afterPairs = new Map<string, string>()
  for (const ref of after) {
    afterPairs.set(`${ref.id}\u0000${ref.sourceField ?? ''}`, ref.id)
  }

  const emitted = new Set<string>()
  for (const [key, id] of beforePairs) {
    if (!afterPairs.has(key) && !emitted.has(id)) {
      emitted.add(id)
      emit(BACKLINKS_TARGET_INVALIDATION_CHANNEL, id)
    }
  }
  for (const [key, id] of afterPairs) {
    if (!beforePairs.has(key) && !emitted.has(id)) {
      emitted.add(id)
      emit(BACKLINKS_TARGET_INVALIDATION_CHANNEL, id)
    }
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

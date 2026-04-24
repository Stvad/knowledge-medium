import type { BlockData } from '@/types'

const cloneBlockData = (blockData: BlockData) => structuredClone(blockData)

const blockFingerprint = (blockData: BlockData | undefined) =>
  blockData ? JSON.stringify(blockData) : ''

export class BlockCache {
  private readonly snapshots = new Map<string, BlockData>()
  private readonly revisions = new Map<string, number>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly dirty = new Set<string>()
  private readonly pendingLoads = new Map<string, Promise<BlockData | undefined>>()

  getSnapshot(id: string): BlockData | undefined {
    return this.snapshots.get(id)
  }

  hasSnapshot(id: string): boolean {
    return this.snapshots.has(id)
  }

  requireSnapshot(id: string): BlockData {
    const snapshot = this.snapshots.get(id)
    if (!snapshot) {
      throw new Error(`Block is not loaded yet: ${id}`)
    }
    return snapshot
  }

  setSnapshot(snapshot: BlockData): boolean {
    const next = cloneBlockData(snapshot)
    const existing = this.snapshots.get(snapshot.id)

    if (existing && blockFingerprint(existing) === blockFingerprint(next)) {
      return false
    }

    this.snapshots.set(snapshot.id, next)
    this.revisions.set(snapshot.id, this.getRevision(snapshot.id) + 1)
    this.notify(snapshot.id)
    return true
  }

  deleteSnapshot(id: string): boolean {
    if (!this.snapshots.delete(id)) return false

    this.revisions.set(id, this.getRevision(id) + 1)
    this.notify(id)
    return true
  }

  hydrate(snapshot: BlockData): void {
    const existing = this.snapshots.get(snapshot.id)

    if (this.dirty.has(snapshot.id)) {
      if (existing && blockFingerprint(existing) !== blockFingerprint(snapshot)) {
        return
      }
      this.dirty.delete(snapshot.id)
    }

    this.setSnapshot(snapshot)
  }

  subscribe(id: string, listener: () => void): () => void {
    let listeners = this.listeners.get(id)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(id, listeners)
    }
    listeners.add(listener)

    return () => {
      listeners?.delete(listener)
      if (listeners?.size === 0) {
        this.listeners.delete(id)
      }
    }
  }

  getRevision(id: string): number {
    return this.revisions.get(id) ?? 0
  }

  markDirty(id: string): void {
    this.dirty.add(id)
  }

  isDirty(id: string): boolean {
    return this.dirty.has(id)
  }

  clearDirty(id: string): void {
    this.dirty.delete(id)
  }

  trackedIds(): Set<string> {
    return new Set([...this.listeners.keys(), ...this.dirty])
  }

  dedupLoad(
    id: string,
    loader: () => Promise<BlockData | undefined>,
  ): Promise<BlockData | undefined> {
    const existing = this.pendingLoads.get(id)
    if (existing) return existing

    const promise = loader().finally(() => {
      this.pendingLoads.delete(id)
    })
    this.pendingLoads.set(id, promise)
    return promise
  }

  private notify(id: string): void {
    this.listeners.get(id)?.forEach(listener => listener())
  }
}

import { describe, expect, it, vi } from 'vitest'
import { BlockCache } from '@/data/blockCache'
import type { BlockData } from '@/types'

const makeSnapshot = (overrides: Partial<BlockData> = {}): BlockData => ({
  id: 'block-1',
  workspaceId: 'workspace-1',
  content: '',
  properties: {},
  childIds: [],
  createTime: 0,
  updateTime: 0,
  createdByUserId: 'user',
  updatedByUserId: 'user',
  references: [],
  ...overrides,
})

describe('BlockCache snapshot storage', () => {
  it('returns undefined for unknown ids', () => {
    const cache = new BlockCache()
    expect(cache.getSnapshot('missing')).toBeUndefined()
    expect(cache.hasSnapshot('missing')).toBe(false)
  })

  it('throws from requireSnapshot when the id is unknown', () => {
    const cache = new BlockCache()
    expect(() => cache.requireSnapshot('missing'))
      .toThrowError('Block is not loaded yet: missing')
  })

  it('stores a defensive clone so external mutations do not bleed in', () => {
    const cache = new BlockCache()
    const original = makeSnapshot({content: 'hello'})

    cache.setSnapshot(original)
    original.content = 'mutated'

    expect(cache.getSnapshot('block-1')?.content).toBe('hello')
  })

})

describe('BlockCache change detection', () => {
  it('reports a change on first set and on differing content', () => {
    const cache = new BlockCache()
    expect(cache.setSnapshot(makeSnapshot({content: 'a'}))).toBe(true)
    expect(cache.setSnapshot(makeSnapshot({content: 'b'}))).toBe(true)
  })

  it('returns false when the incoming snapshot fingerprint matches the existing one', () => {
    const cache = new BlockCache()
    cache.setSnapshot(makeSnapshot({content: 'a'}))
    expect(cache.setSnapshot(makeSnapshot({content: 'a'}))).toBe(false)
  })

  it('reports false from deleteSnapshot when nothing was cached', () => {
    const cache = new BlockCache()
    expect(cache.deleteSnapshot('missing')).toBe(false)
  })

  it('reports true from deleteSnapshot when the snapshot existed', () => {
    const cache = new BlockCache()
    cache.setSnapshot(makeSnapshot())
    expect(cache.deleteSnapshot('block-1')).toBe(true)
    expect(cache.hasSnapshot('block-1')).toBe(false)
  })
})

describe('BlockCache revisions', () => {
  it('starts at zero for unseen ids', () => {
    const cache = new BlockCache()
    expect(cache.getRevision('block-1')).toBe(0)
  })

  it('increments only when the snapshot actually changes', () => {
    const cache = new BlockCache()
    cache.setSnapshot(makeSnapshot({content: 'a'}))
    expect(cache.getRevision('block-1')).toBe(1)

    cache.setSnapshot(makeSnapshot({content: 'a'}))
    expect(cache.getRevision('block-1')).toBe(1)

    cache.setSnapshot(makeSnapshot({content: 'b'}))
    expect(cache.getRevision('block-1')).toBe(2)
  })

  it('increments on delete and survives subsequent sets', () => {
    const cache = new BlockCache()
    cache.setSnapshot(makeSnapshot({content: 'a'}))
    cache.deleteSnapshot('block-1')
    expect(cache.getRevision('block-1')).toBe(2)

    cache.setSnapshot(makeSnapshot({content: 'a'}))
    expect(cache.getRevision('block-1')).toBe(3)
  })
})

describe('BlockCache subscriptions', () => {
  it('fires every subscribed listener on set', () => {
    const cache = new BlockCache()
    const a = vi.fn()
    const b = vi.fn()
    cache.subscribe('block-1', a)
    cache.subscribe('block-1', b)

    cache.setSnapshot(makeSnapshot({content: 'first'}))

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('does not fire listeners when the snapshot is unchanged', () => {
    const cache = new BlockCache()
    cache.setSnapshot(makeSnapshot({content: 'a'}))
    const listener = vi.fn()
    cache.subscribe('block-1', listener)

    cache.setSnapshot(makeSnapshot({content: 'a'}))
    expect(listener).not.toHaveBeenCalled()
  })

  it('fires listeners on delete', () => {
    const cache = new BlockCache()
    cache.setSnapshot(makeSnapshot())
    const listener = vi.fn()
    cache.subscribe('block-1', listener)

    cache.deleteSnapshot('block-1')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not fire listeners on a no-op delete', () => {
    const cache = new BlockCache()
    const listener = vi.fn()
    cache.subscribe('block-1', listener)

    cache.deleteSnapshot('block-1')
    expect(listener).not.toHaveBeenCalled()
  })

  it('removes the listener on unsubscribe', () => {
    const cache = new BlockCache()
    const listener = vi.fn()
    const unsubscribe = cache.subscribe('block-1', listener)

    unsubscribe()
    cache.setSnapshot(makeSnapshot({content: 'x'}))
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('BlockCache dirty tracking', () => {
  it('tracks dirty ids independently of snapshot presence', () => {
    const cache = new BlockCache()
    cache.markDirty('block-1')
    expect(cache.isDirty('block-1')).toBe(true)
    expect(cache.hasSnapshot('block-1')).toBe(false)
  })

  it('clears dirty on demand', () => {
    const cache = new BlockCache()
    cache.markDirty('block-1')
    cache.clearDirty('block-1')
    expect(cache.isDirty('block-1')).toBe(false)
  })
})

describe('BlockCache hydrate (dirty-aware)', () => {
  it('applies the incoming snapshot when nothing is dirty', () => {
    const cache = new BlockCache()
    cache.hydrate(makeSnapshot({content: 'fresh'}))
    expect(cache.getSnapshot('block-1')?.content).toBe('fresh')
  })

  it('drops the incoming snapshot when it differs from a dirty local copy', () => {
    const cache = new BlockCache()
    cache.setSnapshot(makeSnapshot({content: 'local'}))
    cache.markDirty('block-1')

    cache.hydrate(makeSnapshot({content: 'remote'}))

    expect(cache.getSnapshot('block-1')?.content).toBe('local')
    expect(cache.isDirty('block-1')).toBe(true)
  })

  it('clears dirty and accepts the snapshot when the remote already matches the local copy', () => {
    const cache = new BlockCache()
    cache.setSnapshot(makeSnapshot({content: 'local'}))
    cache.markDirty('block-1')

    cache.hydrate(makeSnapshot({content: 'local'}))

    expect(cache.isDirty('block-1')).toBe(false)
  })

  it('hydrating a dirty id with no existing snapshot accepts and clears dirty', () => {
    const cache = new BlockCache()
    cache.markDirty('block-1')

    cache.hydrate(makeSnapshot({content: 'remote'}))

    expect(cache.getSnapshot('block-1')?.content).toBe('remote')
    expect(cache.isDirty('block-1')).toBe(false)
  })
})

describe('BlockCache trackedIds', () => {
  it('returns the union of subscribed ids and dirty ids', () => {
    const cache = new BlockCache()
    cache.subscribe('a', () => {})
    cache.markDirty('b')

    expect(cache.trackedIds()).toEqual(new Set(['a', 'b']))
  })

  it('drops a subscribed id once the last listener unsubscribes', () => {
    const cache = new BlockCache()
    const unsubscribe = cache.subscribe('a', () => {})
    cache.markDirty('b')

    unsubscribe()
    expect(cache.trackedIds()).toEqual(new Set(['b']))
  })
})

describe('BlockCache dedupLoad', () => {
  it('returns the same in-flight promise for concurrent callers', async () => {
    const cache = new BlockCache()
    let resolveLoader!: (value: BlockData | undefined) => void
    const loader = vi.fn(() => new Promise<BlockData | undefined>((resolve) => {
      resolveLoader = resolve
    }))

    const first = cache.dedupLoad('block-1', loader)
    const second = cache.dedupLoad('block-1', loader)

    expect(loader).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)

    resolveLoader(makeSnapshot())
    await first
  })

  it('runs a fresh loader after the previous load resolves', async () => {
    const cache = new BlockCache()
    const loader = vi.fn(() => Promise.resolve(makeSnapshot()))

    await cache.dedupLoad('block-1', loader)
    await cache.dedupLoad('block-1', loader)

    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('runs a fresh loader after the previous load rejects', async () => {
    const cache = new BlockCache()
    const failing = vi.fn(() => Promise.reject(new Error('boom')))

    await expect(cache.dedupLoad('block-1', failing)).rejects.toThrow('boom')

    const succeeding = vi.fn(() => Promise.resolve(makeSnapshot()))
    await cache.dedupLoad('block-1', succeeding)

    expect(succeeding).toHaveBeenCalledTimes(1)
  })

  it('keeps loads for different ids independent', async () => {
    const cache = new BlockCache()
    const loaderA = vi.fn(() => Promise.resolve(makeSnapshot({id: 'a'})))
    const loaderB = vi.fn(() => Promise.resolve(makeSnapshot({id: 'b'})))

    await Promise.all([
      cache.dedupLoad('a', loaderA),
      cache.dedupLoad('b', loaderB),
    ])

    expect(loaderA).toHaveBeenCalledTimes(1)
    expect(loaderB).toHaveBeenCalledTimes(1)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getModePin } from './modePin.js'
import { seedModePinsFromWorkspaces, type SeedReader } from './rolloutSeed.js'

const USER = 'user-1'

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

const reader = (rows: Array<{ id: string; encryption_mode: string }>): SeedReader => ({
  getAll: vi.fn(async () => rows as never),
})

describe('seedModePinsFromWorkspaces (§6 rollout seed)', () => {
  it('pins plaintext for server-none workspaces and e2ee for server-e2ee', async () => {
    const db = reader([
      { id: 'ws-1', encryption_mode: 'none' },
      { id: 'ws-2', encryption_mode: 'e2ee' },
    ])
    const written = await seedModePinsFromWorkspaces(db, USER)
    expect(written).toBe(2)
    expect(getModePin(USER, 'ws-1')).toBe('plaintext')
    expect(getModePin(USER, 'ws-2')).toBe('e2ee')
  })

  it('is once-only: a second call writes nothing and never re-queries the DB', async () => {
    const db = reader([{ id: 'ws-1', encryption_mode: 'none' }])
    await seedModePinsFromWorkspaces(db, USER)
    const written = await seedModePinsFromWorkspaces(db, USER)
    expect(written).toBe(0)
    // arePinsSeeded short-circuits before the second query.
    expect(db.getAll).toHaveBeenCalledTimes(1)
  })

  it('does not throw when pin writes fail (storage disabled) so startup can continue', async () => {
    const db = reader([{ id: 'ws-1', encryption_mode: 'none' }])
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('localStorage is blocked')
    })
    try {
      await expect(seedModePinsFromWorkspaces(db, USER)).resolves.toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('seeds an empty set (fresh device) and marks seeded so later syncs take the gate', async () => {
    const db = reader([])
    const written = await seedModePinsFromWorkspaces(db, USER)
    expect(written).toBe(0)
    // A workspace that syncs in AFTER the seal is NOT seeded — stays unpinned.
    const db2 = reader([{ id: 'ws-late', encryption_mode: 'none' }])
    expect(await seedModePinsFromWorkspaces(db2, USER)).toBe(0)
    expect(getModePin(USER, 'ws-late')).toBeNull()
  })
})

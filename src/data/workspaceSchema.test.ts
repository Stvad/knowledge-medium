import { describe, expect, it } from 'vitest'
import { ensureWorkspaceE2eeColumns, parseWorkspaceRow, type WorkspaceRow } from './workspaceSchema.js'

/** Minimal db stand-in: PRAGMA table_info returns `existing`, and we
 *  record every ALTER that runs. */
const fakeDb = (existing: string[]) => {
  const executed: string[] = []
  return {
    executed,
    execute: async (sql: string) => {
      executed.push(sql)
    },
    // Param omitted — structural typing lets a 0-arg fn satisfy the
    // (sql: string) signature, and an unused named param trips lint.
    getAll: async <T>(): Promise<T[]> =>
      existing.map((name) => ({ name })) as unknown as T[],
  }
}

describe('ensureWorkspaceE2eeColumns', () => {
  it('adds both columns when neither exists (upgrading device)', async () => {
    const db = fakeDb(['id', 'name', 'owner_user_id', 'create_time', 'update_time'])
    await ensureWorkspaceE2eeColumns(db)
    expect(db.executed).toHaveLength(2)
    expect(db.executed[0]).toContain('ADD COLUMN encryption_mode')
    expect(db.executed[0]).toContain("DEFAULT 'none'")
    expect(db.executed[1]).toContain('ADD COLUMN wk_canary')
  })

  it('is a no-op when both columns already exist (fresh install)', async () => {
    const db = fakeDb([
      'id', 'name', 'owner_user_id', 'create_time', 'update_time',
      'encryption_mode', 'wk_canary',
    ])
    await ensureWorkspaceE2eeColumns(db)
    expect(db.executed).toEqual([])
  })

  it('adds only the missing column on partial presence', async () => {
    const db = fakeDb([
      'id', 'name', 'owner_user_id', 'create_time', 'update_time',
      'encryption_mode',
    ])
    await ensureWorkspaceE2eeColumns(db)
    expect(db.executed).toHaveLength(1)
    expect(db.executed[0]).toContain('ADD COLUMN wk_canary')
  })
})

describe('parseWorkspaceRow — E2EE columns', () => {
  const baseRow: WorkspaceRow = {
    id: 'ws-1',
    name: 'WS',
    owner_user_id: 'u-1',
    create_time: 1,
    update_time: 2,
    encryption_mode: 'none',
    wk_canary: null,
    properties_migration: null,
  }

  it('carries encryption_mode / wk_canary into the domain object (not dropped)', () => {
    const parsed = parseWorkspaceRow({
      ...baseRow,
      encryption_mode: 'e2ee',
      wk_canary: 'enc:v1:abc',
    })
    expect(parsed.encryptionMode).toBe('e2ee')
    expect(parsed.wkCanary).toBe('enc:v1:abc')
  })

  it('maps a plaintext workspace to none / null', () => {
    const parsed = parseWorkspaceRow(baseRow)
    expect(parsed.encryptionMode).toBe('none')
    expect(parsed.wkCanary).toBeNull()
  })
})

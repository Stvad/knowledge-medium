import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {ensureLocalPersonalWorkspace, getLocalWorkspace} from '@/data/workspaces'
import {readIsChildBackedWorkspace} from '@/data/workspaceSchema'

let testDb: TestDb
beforeAll(async () => { testDb = await createTestDb() })
afterAll(async () => { await testDb.cleanup() })
beforeEach(async () => { await resetTestDb(testDb.db) })

describe('local personal workspace creation', () => {
  it('starts with child-backed properties in the returned and persisted workspace', async () => {
    const {repo} = createTestRepo({db: testDb.db})

    const created = await ensureLocalPersonalWorkspace(repo)

    expect(created.inserted).toBe(true)
    expect(created.workspace.propertiesMigration).toBe('children')
    expect(await readIsChildBackedWorkspace(testDb.db, created.workspace.id)).toBe(true)
    expect(await getLocalWorkspace(repo, created.workspace.id)).toEqual(created.workspace)
    expect(await ensureLocalPersonalWorkspace(repo)).toEqual({...created, inserted: false})
  })

  it.each(['cell', null])('keeps an existing workspace with stored state %s unchanged', async state => {
    const {repo} = createTestRepo({db: testDb.db})
    const created = await ensureLocalPersonalWorkspace(repo)
    await testDb.db.execute(
      'UPDATE workspaces SET properties_migration = ? WHERE id = ?',
      [state, created.workspace.id],
    )

    const existing = await ensureLocalPersonalWorkspace(repo)

    expect(existing).toEqual({
      ...created,
      inserted: false,
      workspace: {...created.workspace, propertiesMigration: 'cell'},
    })
    expect(await testDb.db.get<{properties_migration: string | null}>(
      'SELECT properties_migration FROM workspaces WHERE id = ?', [created.workspace.id],
    )).toEqual({properties_migration: state})
  })
})

import {afterAll, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {makeBlockData} from '@/data/test/factories'
import {drainStaged, serverBlock, syncServer} from '@/data/test/syncCheckpoint'
import {openWorkspaceData} from './openWorkspaceData'

let database: TestDb
beforeAll(async () => { database = await createTestDb() })
beforeEach(async () => { await resetTestDb(database.db) })
afterAll(async () => { await database.cleanup() })

it('derives reference targets on read-only open without writing document rows or queueing uploads', async () => {
  const {db} = database
  const workspaceId = 'read-only'
  const referenceId = 'legacy-reference'
  await syncServer(db)([serverBlock(makeBlockData({id: referenceId, workspaceId, content: '((target))'}))])
  await drainStaged(db)
  const readRows = () => db.getAll('SELECT id, content, reference_target_id FROM blocks')
  expect(await readRows()).toEqual([{id: referenceId, content: '((target))', reference_target_id: null}])
  expect(await db.getAll('SELECT * FROM ps_crud')).toEqual([])

  const {repo} = createTestRepo({db, isReadOnly: true, backfillCompletionClaim: undefined})
  repo.setActiveWorkspaceId(workspaceId)
  await repo.whenPropertyDefinitionsReady(workspaceId)
  const scheduleSeeds = vi.spyOn(repo, 'scheduleWorkspaceSeedMaterialization')
  await Promise.all(await openWorkspaceData(repo, workspaceId))
  await vi.waitFor(async () => {
    expect(await readRows()).toEqual([{id: referenceId, content: '((target))', reference_target_id: 'target'}])
  })
  await repo.awaitDeferredWork()

  expect(scheduleSeeds).toHaveBeenCalledWith(workspaceId, false)
  expect(await db.getAll('SELECT * FROM ps_crud')).toEqual([])
})

it('cancels pending definitions without starting derivations when the late result arrives', async () => {
  const {repo} = createTestRepo({db: database.db, isReadOnly: true})
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  vi.spyOn(repo, 'whenPropertyDefinitionsReady').mockReturnValue(pending)
  const derive = vi.spyOn(repo, 'scheduleReferenceTargetDerivePass')
  const controller = new AbortController()
  const opening = openWorkspaceData(repo, 'scratch', false, undefined, controller.signal)
  controller.abort()
  try {
    await expect(opening).rejects.toBe(controller.signal.reason)
  } finally {
    finish()
  }
  await pending
  expect(derive).not.toHaveBeenCalled()
})

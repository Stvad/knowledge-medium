// @vitest-environment node
import {afterAll, beforeAll, beforeEach, expect, it} from 'vitest'
import {ChangeScope} from '@/data/api'
import {typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {referencesDataExtension} from '@/plugins/references/dataExtension'
import {annotationsDataExtension} from './dataExtension'
import {THREAD_COMMENTS_SQL} from './mentionThreads'
import {annotationTargetProp, THREAD_TYPE} from './schema'
import {threadCoverageCte} from './threadCoverage'
import {createThread} from './threads'

const WS = 'ws'
const TARGET = '00000000-0000-4000-8000-000000000001'
const opts = {scope: ChangeScope.BlockDefault}
let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, newId: () => crypto.randomUUID(), extensions: [referencesDataExtension, annotationsDataExtension]}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(tx => tx.create({id: TARGET, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Target'}), opts)
})

const covered = (root: string) => db.db.getAll<{start_id: string; id: string}>(THREAD_COMMENTS_SQL, [JSON.stringify([root]), WS])
const staleType = (id: string) => db.db.execute(
  'INSERT OR IGNORE INTO block_types (block_id, workspace_id, type) VALUES (?, ?, ?)', [id, WS, THREAD_TYPE],
)

it('deduplicates a cycle through a scope comment and the thread targeting it', async () => {
  const thread = await createThread(repo, {targetId: TARGET, anchor: null, comment: 'Reply'})
  await repo.tx(tx => tx.move(TARGET, {parentId: thread.threadId, orderKey: 'a1'}), opts)
  const cte = threadCoverageCte('SELECT id, id, NULL, workspace_id FROM blocks WHERE id = ?', () => '0')
  // The limit lets a mutation without deduplication return instead of growing
  // forever; the complete answer has four distinct membership rows.
  const rows = await db.db.getAll(`${cte} SELECT id, thread_id FROM covered LIMIT 20`, [TARGET])
  expect(rows).toHaveLength(4)
})

it('rejects untyped, deleted and foreign-workspace roots even when their ids are supplied', async () => {
  await repo.tx(async tx => {
    await tx.create({id: 'untyped', workspaceId: WS, parentId: null, orderKey: 'a1'})
    await tx.create({id: 'foreign', workspaceId: WS, parentId: null, orderKey: 'a2', properties: {[typesProp.name]: [THREAD_TYPE]}})
    await tx.create({id: 'deleted', workspaceId: WS, parentId: null, orderKey: 'a3', properties: {[typesProp.name]: [THREAD_TYPE]}})
    await tx.delete('deleted')
  }, opts)
  await repo.awaitProcessors()
  await db.db.execute('UPDATE blocks SET workspace_id = ? WHERE id = ?', ['other-ws', 'foreign'])
  await staleType('deleted')
  for (const id of ['untyped', 'deleted', 'foreign']) expect(await covered(id)).toEqual([])
})

it('does not descend into deleted or foreign-workspace children', async () => {
  const thread = await createThread(repo, {targetId: TARGET, anchor: null, comment: 'Live'})
  await repo.tx(async tx => {
    await tx.create({id: 'deleted-child', workspaceId: WS, parentId: thread.threadId, orderKey: 'a1'})
    await tx.delete('deleted-child')
    await tx.create({id: 'foreign-child', workspaceId: WS, parentId: null, orderKey: 'a2'})
  }, opts)
  await repo.awaitProcessors()
  await db.db.execute('UPDATE blocks SET workspace_id = ?, parent_id = ? WHERE id = ?', ['other-ws', thread.threadId, 'foreign-child'])
  const ids = (await covered(thread.threadId)).map(row => row.id)
  expect(ids).toContain(thread.commentId)
  expect(ids).not.toContain('deleted-child')
  expect(ids).not.toContain('foreign-child')
})

it('does not follow foreign or deleted roots through stale target edges', async () => {
  const thread = await createThread(repo, {targetId: TARGET, anchor: null, comment: 'Live'})
  await repo.tx(async tx => {
    await tx.create({id: 'foreign-root', workspaceId: WS, parentId: null, orderKey: 'a1', properties: {[typesProp.name]: [THREAD_TYPE]}})
    await tx.create({id: 'deleted-root', workspaceId: WS, parentId: null, orderKey: 'a2', properties: {[typesProp.name]: [THREAD_TYPE]}})
    await tx.delete('deleted-root')
  }, opts)
  await repo.awaitProcessors()
  await db.db.execute('UPDATE blocks SET workspace_id = ? WHERE id = ?', ['other-ws', 'foreign-root'])
  await staleType('deleted-root')
  for (const id of ['foreign-root', 'deleted-root']) await db.db.execute(
    'INSERT INTO block_references (source_id, target_id, workspace_id, alias, source_field) VALUES (?, ?, ?, ?, ?)',
    [id, thread.commentId!, WS, 'stale', annotationTargetProp.name],
  )
  const ids = (await covered(thread.threadId)).map(row => row.id)
  expect(ids).toContain(thread.commentId)
  expect(ids).not.toContain('foreign-root')
  expect(ids).not.toContain('deleted-root')
})

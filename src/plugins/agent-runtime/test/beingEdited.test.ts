// @vitest-environment node

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BEING_EDITED_BLOCK_IDS_SQL } from '@knowledge-medium/agent-cli/protocol'
import { ChangeScope } from '@/data/api'
import { exitEditModeForBlock, focusBlock } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { BACKLINKS_WATCH_SQL, createWatchEventsRegistry } from '../watchEvents.ts'

const WS = 'ws-1'
const SCOPE = 'outline:root'

let h: TestDb
let repo: Repo
beforeAll(async () => { h = await createTestDb() })
afterAll(async () => { await h.cleanup() })

beforeEach(async () => {
  await resetTestDb(h.db)
  ;({repo} = createTestRepo({db: h.db, user: {id: 'user-1'}, newId: () => crypto.randomUUID()}))
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Root'})
    await tx.create({id: 'mention', workspaceId: WS, parentId: 'root', orderKey: 'a0', content: 'request'})
    await tx.create({id: 'other', workspaceId: WS, parentId: 'root', orderKey: 'a1', content: 'other'})
    await tx.create({id: 'panel-a', workspaceId: WS, parentId: null, orderKey: 'z0', content: 'panel'})
    await tx.create({id: 'panel-b', workspaceId: WS, parentId: null, orderKey: 'z1', content: 'panel'})
  }, {scope: ChangeScope.BlockDefault, description: 'seed'})
})

const beingEdited = async () =>
  (await h.db.getAll<{id: string}>(BEING_EDITED_BLOCK_IDS_SQL)).map(row => row.id).sort()

describe('the being-edited read, against the real focus writers', () => {
  it('reports a block entering an editor', async () => {
    await focusBlock(repo.block('panel-a'), 'mention', {edit: true, renderScopeId: SCOPE})
    expect(await beingEdited()).toEqual(['mention'])
  })

  it('stops reporting it on exit, and on moving to another block', async () => {
    await focusBlock(repo.block('panel-a'), 'mention', {edit: true, renderScopeId: SCOPE})
    await exitEditModeForBlock(repo.block('panel-a'), 'mention', SCOPE)
    expect(await beingEdited()).toEqual([])

    await focusBlock(repo.block('panel-a'), 'mention', {edit: true, renderScopeId: SCOPE})
    await focusBlock(repo.block('panel-a'), 'other', {edit: true, renderScopeId: SCOPE})
    expect(await beingEdited()).toEqual(['other'])
  })

  it('does not report a block that is focused but not in an editor', async () => {
    await focusBlock(repo.block('panel-a'), 'mention', {renderScopeId: SCOPE})
    expect(await beingEdited()).toEqual([])
  })

  it('sees every panel, which is how another device reaches it', async () => {
    await focusBlock(repo.block('panel-a'), 'mention', {edit: true, renderScopeId: SCOPE})
    await focusBlock(repo.block('panel-b'), 'other', {edit: true, renderScopeId: SCOPE})
    expect(await beingEdited()).toEqual(['mention', 'other'])
  })

  it('is served by the partial index', async () => {
    const plan = await h.db.getAll<{detail: string}>(`EXPLAIN QUERY PLAN ${BEING_EDITED_BLOCK_IDS_SQL}`)
    expect(plan.map(row => row.detail).join(' | ')).toContain('idx_blocks_being_edited')
  })
})

describe('the backlinks watcher query', () => {
  beforeEach(async () => {
    await h.db.execute(
      'INSERT INTO block_references (source_id, target_id, workspace_id, alias, source_field) VALUES (?, ?, ?, ?, ?)',
      ['mention', 'root', WS, 'root', ''],
    )
  })

  const row = async () =>
    (await h.db.getAll<{id: string, being_edited: number}>(BACKLINKS_WATCH_SQL, ['root']))[0]

  it('changes its result when the source enters and leaves an editor', async () => {
    expect((await row()).being_edited).toBe(0)
    await focusBlock(repo.block('panel-a'), 'mention', {edit: true, renderScopeId: SCOPE})
    expect((await row()).being_edited).toBe(1)
    await exitEditModeForBlock(repo.block('panel-a'), 'mention', SCOPE)
    expect((await row()).being_edited).toBe(0)
  })

  it('reads 0, not NULL, beside a flag with no focused block', async () => {
    await h.db.execute(
      `UPDATE blocks SET properties_json = json_set(properties_json, '$.isEditing', json('true')) WHERE id = 'panel-b'`,
    )
    expect((await row()).being_edited).toBe(0)
  })

  describe('registered with the real change feed', () => {
    const registry = createWatchEventsRegistry()
    afterEach(() => registry.disposeAll())

    it('wakes its consumer when a held mention leaves the editor', async () => {
      await focusBlock(repo.block('panel-a'), 'mention', {edit: true, renderScopeId: SCOPE})
      const emitted: unknown[] = []
      registry.setTransport(async event => { emitted.push(event) })
      await registry.register(h.db, {
        consumer: 'daemon',
        watchers: [{kind: 'backlinks', name: 'mentions', targetId: 'root', settleMs: 10}],
      })
      expect(emitted).toEqual([])

      await exitEditModeForBlock(repo.block('panel-a'), 'mention', SCOPE)
      await vi.waitFor(() => expect(emitted).toEqual([
        {type: 'watcher-settled', consumer: 'daemon', watcher: 'mentions'},
      ]))
    })
  })
})

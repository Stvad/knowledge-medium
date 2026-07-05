// @vitest-environment node
/**
 * askAgent must ALWAYS produce a real write: the edit-stamp bump is
 * what carries a pre-baseline mention past the daemon's baseline gate,
 * so an ask that changes neither content nor lifecycle props still has
 * to move `coalesce(user_updated_at, updated_at)` forward.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { askAgent } from '../askAgent.ts'
import { AGENT_PROPS } from '../chipState.ts'

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
})

const editStamp = async (id: string): Promise<number> => {
  const rows = await sharedDb.db.getAll<{stamp: number}>(
    'SELECT coalesce(user_updated_at, updated_at) AS stamp FROM blocks WHERE id = ?', [id])
  return rows[0]!.stamp
}

const createBlock = async (id: string, content: string, properties: Record<string, unknown> = {}) => {
  await repo.tx(
    tx => tx.create({id, workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content, properties}),
    {scope: ChangeScope.BlockDefault},
  )
  return new Block(repo, id)
}

describe('askAgent', () => {
  it('bumps the edit stamp even when the mention already exists and no props need clearing', async () => {
    const block = await createBlock('pre-baseline', 'do the thing [[claude]]')
    const before = await editStamp('pre-baseline')

    await new Promise(resolve => setTimeout(resolve, 2)) // stamps are ms-resolution
    await askAgent(block)

    expect(await editStamp('pre-baseline')).toBeGreaterThan(before)
    const row = await block.load()
    expect(typeof row!.properties[AGENT_PROPS.askedAt]).toBe('number')
    expect(row!.content).toBe('do the thing [[claude]]')
  })

  it('appends the mention and clears terminal props, keeping the session', async () => {
    const block = await createBlock('re-ask', 'summarize this', {
      [AGENT_PROPS.status]: 'done',
      [AGENT_PROPS.updatedAt]: 123,
      'agent:session': 'session-1',
    })

    await askAgent(block)

    const row = await block.load()
    expect(row!.content).toBe('summarize this [[claude]]')
    expect(row!.properties[AGENT_PROPS.status]).toBeUndefined()
    expect(row!.properties[AGENT_PROPS.updatedAt]).toBeUndefined()
    expect(row!.properties['agent:session']).toBe('session-1')
  })

  it('bases the write on caller-supplied live content over the persisted row', async () => {
    const block = await createBlock('debounce-window', 'persisted old text')

    await askAgent(block, 'live editor text')

    const row = await block.load()
    expect(row!.content).toBe('live editor text [[claude]]')
  })

  it('clears a stale agent:activity label on requeue (it must not outlive the run it described)', async () => {
    const block = await createBlock('re-ask-activity', 'summarize this', {
      [AGENT_PROPS.status]: 'error',
      [AGENT_PROPS.activity]: 'km: search',
    })

    await askAgent(block)

    const row = await block.load()
    expect(row!.properties[AGENT_PROPS.activity]).toBeUndefined()
  })

  it('clears a stale agent:cancel on requeue so the fresh run is not immediately aborted', async () => {
    const block = await createBlock('re-ask-cancel', 'summarize this', {
      [AGENT_PROPS.status]: 'error',
      [AGENT_PROPS.cancel]: 123,
    })

    await askAgent(block)

    const row = await block.load()
    expect(row!.properties[AGENT_PROPS.cancel]).toBeUndefined()
  })
})

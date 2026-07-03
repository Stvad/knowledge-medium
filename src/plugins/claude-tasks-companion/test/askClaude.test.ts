// @vitest-environment node
/**
 * askClaude must ALWAYS produce a real write: the edit-stamp bump is
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
import { askClaude } from '../askClaude.ts'
import { CLAUDE_PROPS } from '../chipState.ts'

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

describe('askClaude', () => {
  it('bumps the edit stamp even when the mention already exists and no props need clearing', async () => {
    const block = await createBlock('pre-baseline', 'do the thing [[claude]]')
    const before = await editStamp('pre-baseline')

    await new Promise(resolve => setTimeout(resolve, 2)) // stamps are ms-resolution
    await askClaude(block)

    expect(await editStamp('pre-baseline')).toBeGreaterThan(before)
    const row = await block.load()
    expect(typeof row!.properties[CLAUDE_PROPS.askedAt]).toBe('number')
    expect(row!.content).toBe('do the thing [[claude]]')
  })

  it('appends the mention and clears terminal props, keeping the session', async () => {
    const block = await createBlock('re-ask', 'summarize this', {
      [CLAUDE_PROPS.status]: 'done',
      [CLAUDE_PROPS.updatedAt]: 123,
      'claude:session': 'session-1',
    })

    await askClaude(block)

    const row = await block.load()
    expect(row!.content).toBe('summarize this [[claude]]')
    expect(row!.properties[CLAUDE_PROPS.status]).toBeUndefined()
    expect(row!.properties[CLAUDE_PROPS.updatedAt]).toBeUndefined()
    expect(row!.properties['claude:session']).toBe('session-1')
  })
})

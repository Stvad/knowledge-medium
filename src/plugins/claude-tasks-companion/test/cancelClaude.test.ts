// @vitest-environment node
/**
 * cancelClaude's only job is writing claude:cancel on a still-running
 * block — the daemon owns aborting the process and parking the
 * terminal error:cancelled state. Everything else must be a no-op: a
 * stray cancel signal on a done/queued/status-less block has no
 * running process for the daemon to kill.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { cancelClaude } from '../cancelClaude.ts'
import { CLAUDE_PROPS } from '../chipState.ts'

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
})

const createBlock = async (id: string, properties: Record<string, unknown> = {}) => {
  await repo.tx(
    tx => tx.create({id, workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'do the thing', properties}),
    {scope: ChangeScope.BlockDefault},
  )
  return new Block(repo, id)
}

describe('cancelClaude', () => {
  it('writes claude:cancel on a running block', async () => {
    const block = await createBlock('running-task', {[CLAUDE_PROPS.status]: 'running'})

    await cancelClaude(block)

    const row = await block.load()
    expect(typeof row!.properties[CLAUDE_PROPS.cancel]).toBe('number')
  })

  it('is a no-op on a done block', async () => {
    const block = await createBlock('done-task', {[CLAUDE_PROPS.status]: 'done'})

    await cancelClaude(block)

    const row = await block.load()
    expect(row!.properties[CLAUDE_PROPS.cancel]).toBeUndefined()
  })

  it('is a no-op on a block with no claude:status', async () => {
    const block = await createBlock('no-status-task')

    await cancelClaude(block)

    const row = await block.load()
    expect(row!.properties[CLAUDE_PROPS.cancel]).toBeUndefined()
  })
})

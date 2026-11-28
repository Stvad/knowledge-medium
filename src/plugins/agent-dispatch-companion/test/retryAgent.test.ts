// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { ChangeScope, propertyValue } from '@/data/api'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { AGENT_PROPS } from '../chipState.ts'
import { agentDispatchCompanionDataExtension } from '../dataExtension.ts'
import { retryAgent } from '../retryAgent.ts'
import { agentStatusProp } from '../schema.ts'

let testDb: TestDb
let repo: Repo
beforeAll(async () => { testDb = await createTestDb() })
afterAll(async () => { await testDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(testDb.db)
  repo = createTestRepo({db: testDb.db, extensions: [agentDispatchCompanionDataExtension]}).repo
})

const request = 'Summarize this [[Review Bot]]'

const failedTask = async (properties: Record<string, unknown> = {}) => {
  const id = await repo.tx(tx => tx.create({
    workspaceId: 'test-workspace', parentId: null, orderKey: 'a0', content: request,
    properties: {[AGENT_PROPS.status]: 'error', [AGENT_PROPS.watcher]: 'review', ...properties},
  }), {scope: ChangeScope.BlockDefault})
  return repo.block(id)
}

it('requeues the original request and retains the watcher, resume information, and reply attempt', async () => {
  const retained = {
    [AGENT_PROPS.watcher]: 'review',
    [AGENT_PROPS.executor]: 'codex',
    [AGENT_PROPS.session]: 'codex:thread-1',
    [AGENT_PROPS.resumeOptions]: {version: 1, executor: 'codex'},
    [AGENT_PROPS.attempts]: 3,
    'other-property': 'keep',
  }
  const block = await failedTask({
    ...retained,
    [AGENT_PROPS.error]: 'Authentication expired',
    [AGENT_PROPS.activity]: 'Thinking',
    [AGENT_PROPS.activityAt]: 120,
    [AGENT_PROPS.cancel]: 121,
  })
  const before = (await block.load())!

  await retryAgent(block)

  const row = (await block.load())!
  expect(row.properties).toEqual({
    ...before.properties,
    ...retained,
    [AGENT_PROPS.status]: 'queued',
    [AGENT_PROPS.updatedAt]: expect.any(Number),
    [AGENT_PROPS.error]: undefined,
    [AGENT_PROPS.activity]: undefined,
    [AGENT_PROPS.activityAt]: undefined,
    [AGENT_PROPS.cancel]: undefined,
  })
  expect(row.content).toBe(request)
  expect(row.userUpdatedAt).toBeGreaterThan(before.userUpdatedAt!)
})

it('keeps a run that advanced since the user opened the failed chip', async () => {
  const block = await failedTask()
  await repo.tx(tx => tx.setProperties(block.id, {set: [propertyValue(agentStatusProp, 'running')]}),
    {scope: ChangeScope.BlockDefault})

  await retryAgent(block)

  expect((await block.load())!.properties[AGENT_PROPS.status]).toBe('running')
})

it('does not queue a task without its original watcher', async () => {
  const block = await failedTask({[AGENT_PROPS.watcher]: ''})

  await retryAgent(block)

  expect((await block.load())!.properties[AGENT_PROPS.status]).toBe('error')
})

it('does not write retry metadata onto a deleted task', async () => {
  const block = await failedTask()
  await repo.tx(tx => tx.delete(block.id), {scope: ChangeScope.BlockDefault})

  await retryAgent(block)

  const row = await repo.tx(tx => tx.get(block.id), {scope: ChangeScope.BlockDefault})
  expect(row?.properties[AGENT_PROPS.status]).toBe('error')
})

it('allows the task to disappear before Retry is selected', async () => {
  await expect(retryAgent(repo.block('missing-task'))).resolves.toBeUndefined()
})

it('does not open a transaction for a read-only workspace', async () => {
  const block = await failedTask()
  repo.setReadOnly(true)
  const tx = vi.spyOn(repo, 'tx')

  try {
    await retryAgent(block)
    expect(tx).not.toHaveBeenCalled()
  } finally {
    tx.mockRestore()
  }
})

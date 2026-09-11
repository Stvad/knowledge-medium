// @vitest-environment node
/**
 * Retry is the manual half of the credit-outage story: the daemon defers
 * the failures it can recognise, and this puts back the ones it parked.
 * The bulk form matters because an outage produces a BATCH — re-queueing
 * them one at a time is what makes recovery feel impossible.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { agentDispatchCompanionDataExtension } from '../dataExtension.ts'
import { AGENT_CANCELLED_ERROR, retryAgentTask, retryFailedAgentTasks } from '../retryAgent.ts'
import { AGENT_PROPS } from '../chipState.ts'

const WORKSPACE = 'ws-1'

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    // The bulk query filters on `agent:status`, which needs the property's
    // registered schema to compile — the same seeds the app installs.
    extensions: [agentDispatchCompanionDataExtension],
  }).repo
  repo.setActiveWorkspaceId(WORKSPACE)
})

let nextOrder = 0
const createBlock = async (id: string, properties: Record<string, unknown>, workspaceId = WORKSPACE) => {
  await repo.tx(
    tx => tx.create({
      id, workspaceId, parentId: null, orderKey: `a${nextOrder++}`,
      content: `[[claude]] ${id}`, properties,
    }),
    {scope: ChangeScope.BlockDefault},
  )
  return new Block(repo, id)
}

const propsOf = async (id: string) => (await new Block(repo, id).load())!.properties

describe('retryAgentTask', () => {
  it('clears the terminal state so the daemon re-derives the task as pending', async () => {
    const block = await createBlock('failed', {
      [AGENT_PROPS.status]: 'error',
      [AGENT_PROPS.error]: 'exit 1: boom',
      [AGENT_PROPS.attempts]: 2,
      [AGENT_PROPS.updatedAt]: 123,
      [AGENT_PROPS.session]: 'session-1',
    })

    expect(await retryAgentTask(block)).toBe(true)

    const props = await propsOf('failed')
    expect(props[AGENT_PROPS.status]).toBeUndefined()
    expect(props[AGENT_PROPS.error]).toBeUndefined()
    expect(props[AGENT_PROPS.attempts]).toBeUndefined()
    // The thread is kept — the retry resumes it rather than starting over.
    expect(props[AGENT_PROPS.session]).toBe('session-1')
    expect(typeof props[AGENT_PROPS.askedAt]).toBe('number')
  })

  it('never rewrites content — the mention may belong to another watcher', async () => {
    // Ask Agent appends [[claude]]; Retry must not, or a task claimed by a
    // `[[codex]]` / custom-target watcher gets silently reassigned.
    await repo.tx(
      tx => tx.create({
        id: 'codex-task', workspaceId: WORKSPACE, parentId: null, orderKey: 'z0',
        content: '[[codex]] fix the flake',
        properties: {[AGENT_PROPS.status]: 'error', [AGENT_PROPS.executor]: 'codex'},
      }),
      {scope: ChangeScope.BlockDefault},
    )

    await retryAgentTask(new Block(repo, 'codex-task'))

    expect((await new Block(repo, 'codex-task').load())!.content).toBe('[[codex]] fix the flake')
  })

  it('clears the retry clock on a DEFERRED task so it goes now, not on the daemon schedule', async () => {
    const block = await createBlock('deferred', {
      [AGENT_PROPS.status]: 'queued',
      [AGENT_PROPS.retryAfter]: Date.now() + 300_000,
      [AGENT_PROPS.error]: 'out of credits / usage limit reached — waiting to retry',
    })

    expect(await retryAgentTask(block)).toBe(true)

    const props = await propsOf('deferred')
    expect(props[AGENT_PROPS.status]).toBeUndefined()
    expect(props[AGENT_PROPS.retryAfter]).toBeUndefined()
  })

  it('refuses to reset a RUNNING task — that would orphan the daemon\'s live run', async () => {
    const block = await createBlock('live', {
      [AGENT_PROPS.status]: 'running',
      [AGENT_PROPS.updatedAt]: 123,
    })

    expect(await retryAgentTask(block)).toBe(false)
    expect((await propsOf('live'))[AGENT_PROPS.status]).toBe('running')
  })

  it('refuses an ordinary block with no agent:status — Retry is offered on every block', async () => {
    // No agent:status means this was never an agent task at all: no
    // watcher mention, nothing the daemon will ever claim. Acting anyway
    // would write agent:asked-at and install a chip stuck forever.
    const block = await createBlock('ordinary', {})

    expect(await retryAgentTask(block)).toBe(false)
    const props = await propsOf('ordinary')
    expect(props[AGENT_PROPS.status]).toBeUndefined()
    expect(props[AGENT_PROPS.askedAt]).toBeUndefined()
  })

  it('does nothing in a read-only repo', async () => {
    const readOnly = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}, isReadOnly: true}).repo
    await createBlock('ro', {[AGENT_PROPS.status]: 'error'})

    expect(await retryAgentTask(new Block(readOnly, 'ro'))).toBe(false)
    expect((await propsOf('ro'))[AGENT_PROPS.status]).toBe('error')
  })
})

describe('retryFailedAgentTasks', () => {
  it('re-queues the whole failed batch in one gesture', async () => {
    await createBlock('failed-1', {[AGENT_PROPS.status]: 'error', [AGENT_PROPS.error]: 'boom'})
    await createBlock('failed-2', {[AGENT_PROPS.status]: 'error', [AGENT_PROPS.error]: 'boom'})
    await createBlock('done-1', {[AGENT_PROPS.status]: 'done'})
    await createBlock('running-1', {[AGENT_PROPS.status]: 'running'})
    await createBlock('untouched', {})

    expect(await retryFailedAgentTasks(repo)).toBe(2)

    expect((await propsOf('failed-1'))[AGENT_PROPS.status]).toBeUndefined()
    expect((await propsOf('failed-2'))[AGENT_PROPS.status]).toBeUndefined()
    // Only failures — a finished reply must not be re-run (and re-billed),
    // and a live run must not be orphaned.
    expect((await propsOf('done-1'))[AGENT_PROPS.status]).toBe('done')
    expect((await propsOf('running-1'))[AGENT_PROPS.status]).toBe('running')
    expect((await propsOf('untouched'))[AGENT_PROPS.askedAt]).toBeUndefined()
  })

  it('leaves other workspaces alone', async () => {
    // The local blocks table holds every synced workspace; a global sweep
    // would re-run (and bill) tasks the user is not even looking at.
    await createBlock('here', {[AGENT_PROPS.status]: 'error'})
    await createBlock('elsewhere', {[AGENT_PROPS.status]: 'error'}, 'ws-other')

    expect(await retryFailedAgentTasks(repo)).toBe(1)

    expect((await propsOf('here'))[AGENT_PROPS.status]).toBeUndefined()
    expect((await propsOf('elsewhere'))[AGENT_PROPS.status]).toBe('error')
  })

  it('reports zero when there is nothing to retry', async () => {
    await createBlock('done-only', {[AGENT_PROPS.status]: 'done'})
    expect(await retryFailedAgentTasks(repo)).toBe(0)
  })

  it('excludes a task the user deliberately Stopped end-to-end', async () => {
    // Both Stop paths park the block as error + error:'cancelled'. The
    // sweep must not resurrect (and re-bill) work the user explicitly
    // stopped — that would defeat Stop's own escape hatch from a retry loop.
    await createBlock('failed', {[AGENT_PROPS.status]: 'error', [AGENT_PROPS.error]: 'boom'})
    await createBlock('stopped', {[AGENT_PROPS.status]: 'error', [AGENT_PROPS.error]: AGENT_CANCELLED_ERROR})

    expect(await retryFailedAgentTasks(repo)).toBe(1)

    expect((await propsOf('failed'))[AGENT_PROPS.status]).toBeUndefined()
    expect((await propsOf('stopped'))[AGENT_PROPS.status]).toBe('error')
    expect((await propsOf('stopped'))[AGENT_PROPS.error]).toBe(AGENT_CANCELLED_ERROR)
  })

  it('in-tx recheck skips a task that turns cancelled after the query snapshot (racing a Stop)', async () => {
    const block = await createBlock('racing-stop', {[AGENT_PROPS.status]: 'error', [AGENT_PROPS.error]: 'boom'})

    // The query result predates the tx (same reasoning as the "picked up by
    // a daemon" recheck above): simulate a Stop landing in that window by
    // having the query call cancel the block for real before returning its
    // (now-stale) snapshot. Only the IN-TX recheck can catch this.
    const originalQuery = repo.queryActiveWorkspace.bind(repo)
    const querySpy = vi.spyOn(repo, 'queryActiveWorkspace').mockImplementation(async query => {
      const rows = await originalQuery(query)
      await repo.tx(
        tx => tx.update(block.id, {
          properties: {[AGENT_PROPS.status]: 'error', [AGENT_PROPS.error]: AGENT_CANCELLED_ERROR},
        }),
        {scope: ChangeScope.BlockDefault},
      )
      return rows
    })

    expect(await retryFailedAgentTasks(repo)).toBe(0)
    querySpy.mockRestore()

    const props = await propsOf('racing-stop')
    expect(props[AGENT_PROPS.status]).toBe('error')
    expect(props[AGENT_PROPS.error]).toBe(AGENT_CANCELLED_ERROR)
  })
})

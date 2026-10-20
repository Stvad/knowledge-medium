// @vitest-environment node

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type RepoTxOptions } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'

declare module '@/data/api/tx' {
  interface TransactionContext {
    outerOnly?: string | null
    innerOnly?: string
    reboundOnly?: string
    txOnly?: string
  }
}

const WS = 'ws-repo-tx-context'
const SCOPE = {scope: ChangeScope.BlockDefault}

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  return {h: sharedDb, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })
afterEach(() => { env.repo.setActiveWorkspaceId(null) })

const captureContext = async (repo: Repo, options: RepoTxOptions = SCOPE) => {
  let context: Readonly<Record<string, unknown>> | undefined
  await repo.tx(async tx => { context = tx.meta.context }, options)
  return context
}

const createWithContext = async (
  repo: Repo,
  id: string,
  contexts: Array<Readonly<Record<string, unknown>> | undefined>,
): Promise<void> => {
  await repo.tx(async tx => {
    contexts.push(tx.meta.context)
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content: id})
  }, SCOPE)
}

describe('Repo.withTxContext', () => {
  it('merges explicit rebindings while tx options cannot replace bound keys', async () => {
    const original = env.repo.withTxContext({
      contributorId: 'outer-agent',
      contributorSource: 'agent',
      outerOnly: 'outer',
    })
    const rebound = original
      .withTxContext({contributorId: 'inner-agent', innerOnly: 'inner'})
      .withTxContext({reboundOnly: 'rebound'})

    const withUndefinedOverride = await captureContext(rebound, {
      ...SCOPE,
      context: {
        contributorId: undefined,
        contributorSource: undefined,
        outerOnly: undefined,
        txOnly: 'from-tx-undefined',
      },
    })
    expect(withUndefinedOverride).toMatchObject({
      contributorId: 'inner-agent',
      contributorSource: 'agent',
      outerOnly: 'outer',
      innerOnly: 'inner',
      reboundOnly: 'rebound',
      txOnly: 'from-tx-undefined',
    })

    const withNullOverride = await captureContext(rebound, {
      ...SCOPE,
      context: {
        contributorId: null,
        contributorSource: undefined,
        outerOnly: null,
        txOnly: 'from-tx-null',
      },
    })
    expect(withNullOverride).toMatchObject({
      contributorId: 'inner-agent',
      contributorSource: 'agent',
      outerOnly: 'outer',
      innerOnly: 'inner',
      reboundOnly: 'rebound',
      txOnly: 'from-tx-null',
    })

    // Explicit facade rebinding is allowed to clear attribution, and it must
    // preserve the unrelated keys captured by the earlier explicit bindings.
    const cleared = rebound.withTxContext({contributorId: null})
    expect(await captureContext(cleared)).toMatchObject({
      contributorId: null,
      contributorSource: 'agent',
      outerOnly: 'outer',
      innerOnly: 'inner',
      reboundOnly: 'rebound',
    })

    // Creating and using a child facade does not mutate the original host.
    expect(await captureContext(original)).toMatchObject({
      contributorId: 'outer-agent',
      contributorSource: 'agent',
      outerOnly: 'outer',
    })
  })

  it('keeps context and one undo group through context→group and group→context rebinding', async () => {
    const contexts: Array<Readonly<Record<string, unknown>> | undefined> = []
    const contextBound = env.repo.withTxContext({
      contributorId: 'context-first',
      contributorSource: 'agent',
      outerOnly: 'context',
    })

    await contextBound.undoGroup(async grouped => {
      await createWithContext(grouped, 'context-group-a', contexts)
      await createWithContext(
        grouped.withTxContext({reboundOnly: 'context-group'}),
        'context-group-b',
        contexts,
      )
    })

    await env.repo.undoGroup(async grouped => {
      const bound = grouped.withTxContext({
        contributorId: 'group-first',
        contributorSource: 'agent',
        outerOnly: 'group',
      })
      await createWithContext(bound, 'group-context-a', contexts)
      await createWithContext(
        bound.withTxContext({reboundOnly: 'group-context'}),
        'group-context-b',
        contexts,
      )
    })

    expect(contexts).toMatchObject([
      {contributorId: 'context-first', contributorSource: 'agent', outerOnly: 'context'},
      {contributorId: 'context-first', contributorSource: 'agent', outerOnly: 'context', reboundOnly: 'context-group'},
      {contributorId: 'group-first', contributorSource: 'agent', outerOnly: 'group'},
      {contributorId: 'group-first', contributorSource: 'agent', outerOnly: 'group', reboundOnly: 'group-context'},
    ])

    const events = await env.repo.db.getAll<{
      block_id: string
      group_id: string | null
    }>('SELECT block_id, group_id FROM row_events ORDER BY id')
    const groupIdFor = (blockId: string): string | null =>
      events.find(event => event.block_id === blockId)?.group_id ?? null
    const contextGroupId = groupIdFor('context-group-a')
    const groupContextId = groupIdFor('group-context-a')
    expect(contextGroupId).not.toBeNull()
    expect(groupContextId).not.toBeNull()
    expect(groupIdFor('context-group-b')).toBe(contextGroupId)
    expect(groupIdFor('group-context-b')).toBe(groupContextId)
    expect(groupContextId).not.toBe(contextGroupId)
    expect(env.repo.undoManager.depths(ChangeScope.BlockDefault)).toEqual({undo: 2, redo: 0})

    // Each pair of txs remains one undo entry in both nesting orders.
    await env.repo.undo()
    expect(await env.repo.load('group-context-a')).toBeNull()
    expect(await env.repo.load('group-context-b')).toBeNull()
    expect(await env.repo.load('context-group-a')).not.toBeNull()
    expect(await env.repo.load('context-group-b')).not.toBeNull()
    await env.repo.undo()
    expect(await env.repo.load('context-group-a')).toBeNull()
    expect(await env.repo.load('context-group-b')).toBeNull()
  })
})

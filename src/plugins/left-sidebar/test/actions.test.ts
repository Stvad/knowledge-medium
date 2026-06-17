// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { User } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import {
  __resetLayoutSessionIdForTesting,
} from '@/utils/layoutSessionId'
import { openLeftSidebarAction } from '../index.ts'
import { leftSidebarToggle } from '../toggleStore.ts'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  let id = 0
  const repo = new Repo({
    db: h.db,
    cache: new BlockCache(),
    user: USER,
    newId: () => `gen-${++id}`,
    registerKernelProcessors: false,
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  __resetLayoutSessionIdForTesting()
  env = await setup()
})

afterEach(async () => {
  env.repo.stopSyncObserver()
  leftSidebarToggle.close()
})

describe('left sidebar actions', () => {
  it('opens the sidebar through the global action', () => {
    expect(leftSidebarToggle.isOpen()).toBe(false)

    openLeftSidebarAction.handler(
      {uiStateBlock: {} as never},
      new CustomEvent('test'),
    )

    expect(leftSidebarToggle.isOpen()).toBe(true)
  })
})

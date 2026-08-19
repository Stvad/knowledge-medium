// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { User } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
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
  const { repo } = createTestRepo({
    db: h.db,
    user: USER,
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  __resetLayoutSessionIdForTesting()
  // setup() sets the active workspace as a side effect; the actions under test
  // operate on the global runtime, so the returned handle isn't read directly.
  await setup()
})

afterEach(async () => {
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

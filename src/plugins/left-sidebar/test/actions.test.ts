// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import {
  __resetLayoutSessionIdForTesting,
} from '@/utils/layoutSessionId'
import {
  openLeftSidebarAction,
  openLeftSidebarEvent,
} from '../index.ts'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
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

let env: Harness

beforeEach(async () => {
  __resetLayoutSessionIdForTesting()
  env = await setup()
})

afterEach(async () => {
  await env.h.cleanup()
})

describe('left sidebar actions', () => {
  it('opens the sidebar through the global action', () => {
    const listener = vi.fn()
    window.addEventListener(openLeftSidebarEvent, listener)

    openLeftSidebarAction.handler(
      {uiStateBlock: {} as never},
      new CustomEvent('test'),
    )

    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener(openLeftSidebarEvent, listener)
  })
})

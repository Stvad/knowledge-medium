// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { InMemoryWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { requireWorkspaceKeys } from '@/sync/keys/openWorkspaceKeys'
import { useCloseOnKeyLoss } from './useCloseOnKeyLoss'

const USER = 'user-1'
const WS = 'ws-1'

let shared: TestDb
let repo: Repo
beforeAll(async () => { shared = await createTestDb() })
afterAll(async () => { await shared.cleanup() })
beforeEach(async () => {
  cleanup()
  await resetTestDb(shared.db)
  repo = createTestRepo({db: shared.db, user: {id: USER}}).repo
})

/** A read that finds no key, as the upload path or the observer would make it. */
const readMissingKey = (userId: string, workspaceId: string) =>
  requireWorkspaceKeys(new InMemoryWorkspaceKeyStore(), userId, workspaceId).catch(() => {})

const render = (active = true) => {
  const onClose = vi.fn()
  renderHook(() => useCloseOnKeyLoss(repo, WS, active, onClose))
  return onClose
}

describe('useCloseOnKeyLoss — an open workspace closes when its key read comes up empty', () => {
  it('makes the workspace read-only before the read throws, then re-resolves once', async () => {
    const onClose = render()
    let readOnlyWhenThrown: boolean | undefined
    await requireWorkspaceKeys(new InMemoryWorkspaceKeyStore(), USER, WS)
      .catch(() => { readOnlyWhenThrown = repo.isReadOnly })
    await readMissingKey(USER, WS)

    expect(readOnlyWhenThrown).toBe(true)
    // Every queued upload retry reads the key again; one re-resolve is enough.
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("ignores another workspace's key, and another user's", async () => {
    const onClose = render()
    await readMissingKey(USER, 'ws-other')
    await readMissingKey('user-other', WS)

    expect(onClose).not.toHaveBeenCalled()
    expect(repo.isReadOnly).toBe(false)
  })

  it('does nothing while inactive (a gate is already shown)', async () => {
    const onClose = render(false)
    await readMissingKey(USER, WS)

    expect(onClose).not.toHaveBeenCalled()
    expect(repo.isReadOnly).toBe(false)
  })
})

// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { ChangeScope } from '@/data/api'
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
  repo.setActiveWorkspaceId(WS)
})

/** A read that finds no key, as the upload path or the observer would make it. */
const readMissingKey = (userId: string, workspaceId: string) =>
  requireWorkspaceKeys(new InMemoryWorkspaceKeyStore(), userId, workspaceId).catch(() => {})

const render = (opening: {workspaceId: string} | null = {workspaceId: WS}) => {
  const onClose = vi.fn()
  const hook = renderHook(
    ({current}: {current: {workspaceId: string} | null}) => useCloseOnKeyLoss(repo, current, onClose),
    {initialProps: {current: opening}},
  )
  return {onClose, reopen: () => hook.rerender({current: {workspaceId: WS}})}
}

describe('useCloseOnKeyLoss — an open workspace closes when its key read comes up empty', () => {
  it('re-resolves once per opening, leaving writes open until the gate takes over', async () => {
    const {onClose} = render()
    await readMissingKey(USER, WS)
    // An editor's pending write, flushed as the layout unmounts, still lands.
    await repo.tx(async tx => {
      await tx.create({id: 'pending', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'typed'})
    }, {scope: ChangeScope.BlockDefault, description: 'flush'})
    // Every queued upload retry reads the key again; one re-resolve is enough.
    await readMissingKey(USER, WS)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('watches again once a re-resolve finds the key after all and reopens the workspace', async () => {
    const {onClose, reopen} = render()
    await readMissingKey(USER, WS)
    reopen()
    await readMissingKey(USER, WS)

    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it("ignores another workspace's key, and another user's", async () => {
    const {onClose} = render()
    await readMissingKey(USER, 'ws-other')
    await readMissingKey('user-other', WS)

    expect(onClose).not.toHaveBeenCalled()
  })

  it("ignores the previous workspace's key while another one opens", async () => {
    const {onClose} = render()
    repo.setActiveWorkspaceId('ws-next')
    await readMissingKey(USER, WS)

    expect(onClose).not.toHaveBeenCalled()
  })

  it('does nothing while no workspace is open (a gate is already shown)', async () => {
    const {onClose} = render(null)
    await readMissingKey(USER, WS)

    expect(onClose).not.toHaveBeenCalled()
  })
})

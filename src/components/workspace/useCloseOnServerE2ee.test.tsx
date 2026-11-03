// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { setModePin } from '@/sync/keys/modePin'
import { useCloseOnServerE2ee } from './useCloseOnServerE2ee'

const USER = 'user-1'
const WS = 'ws-1'

let shared: TestDb
beforeAll(async () => {
  shared = await createTestDb()
})
afterAll(async () => {
  await shared.cleanup()
})
beforeEach(async () => {
  cleanup()
  localStorage.clear()
  await resetTestDb(shared.db)
  await shared.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode)
     VALUES (?, 'ws', ?, 1, 1, 'none')`,
    [WS, USER],
  )
})

const flip = () => shared.db.execute(
  `UPDATE workspaces SET encryption_mode = 'e2ee', wk_canary = 'enc:v1:canary' WHERE id = ?`, [WS],
)

const render = (active = true) => {
  const onClose = vi.fn()
  renderHook(() => useCloseOnServerE2ee(shared.db, USER, WS, active, onClose))
  return onClose
}

describe('useCloseOnServerE2ee — an open workspace closes when the server converts it', () => {
  it('closes a plaintext-pinned workspace when its synced row flips to e2ee', async () => {
    setModePin(USER, WS, 'plaintext')
    const onClose = render()
    await flip()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('closes on mount when the row already says e2ee', async () => {
    setModePin(USER, WS, 'plaintext')
    await flip()
    const onClose = render()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('leaves an e2ee-pinned workspace open', async () => {
    setModePin(USER, WS, 'e2ee')
    const onClose = render()
    await flip()
    // Prove the change was delivered before asserting the absence: a plaintext
    // workspace watching the same table did close.
    setModePin(USER, 'ws-2', 'plaintext')
    await shared.db.execute(
      `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode)
       VALUES ('ws-2', 'ws', ?, 1, 1, 'e2ee')`,
      [USER],
    )
    const witness = vi.fn()
    renderHook(() => useCloseOnServerE2ee(shared.db, USER, 'ws-2', true, witness))
    await vi.waitFor(() => expect(witness).toHaveBeenCalled())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does nothing while inactive (a gate is already shown)', async () => {
    setModePin(USER, WS, 'plaintext')
    await flip()
    const onClose = render(false)
    const witness = vi.fn()
    renderHook(() => useCloseOnServerE2ee(shared.db, USER, WS, true, witness))
    await vi.waitFor(() => expect(witness).toHaveBeenCalled())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a mode read that fails is logged, not an unhandled rejection', async () => {
    setModePin(USER, WS, 'plaintext')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = {
      ...shared.db,
      onChange: shared.db.onChange.bind(shared.db),
      getOptional: async () => { throw new Error('database closed') },
    } as unknown as typeof shared.db
    const onClose = vi.fn()
    renderHook(() => useCloseOnServerE2ee(failing, USER, WS, true, onClose))
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    expect(onClose).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

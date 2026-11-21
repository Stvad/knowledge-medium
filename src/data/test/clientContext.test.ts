/**
 * `ClientContext.onActingAsChange` — the change-notification channel
 * `repo.client` / `useClientContext()` reactive consumers subscribe to
 * (see `src/context/repo.tsx`). Pure class-level tests: no Repo, no DB.
 *
 * Coverage: fires on an EFFECTIVE change of either field, stays silent on
 * no-ops (including the layout-session id's null <-> base-id folding —
 * `activeLayoutSessionId`'s own fallback semantics), and unsubscribes
 * cleanly. The Repo-level "fires before facet-bridge/projector side
 * effects run" ordering is exercised where it matters — `repoLifecycle.test.ts`
 * — not here, since this file constructs `ClientContext` directly.
 */

// Pin the per-device base id so the fallback assertions are deterministic
// (mirrors repoLifecycle.test.ts's mock of the same module).
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/layoutSessionId', () => ({
  getLayoutSessionId: () => 'base-session-id',
}))

import { ClientContext } from '@/data/clientContext'

const mkClient = () => new ClientContext({user: {id: 'user-1'}})

describe('ClientContext.onActingAsChange', () => {
  it('fires on an effective activeWorkspaceId change', () => {
    const client = mkClient()
    const listener = vi.fn()
    client.onActingAsChange(listener)
    client.setActiveWorkspaceId('ws-1')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not fire when activeWorkspaceId is set to its current value', () => {
    const client = mkClient()
    client.setActiveWorkspaceId('ws-1')
    const listener = vi.fn()
    client.onActingAsChange(listener)
    client.setActiveWorkspaceId('ws-1')
    expect(listener).not.toHaveBeenCalled()
  })

  it('fires on an effective activeLayoutSessionId change', () => {
    const client = mkClient()
    const listener = vi.fn()
    client.onActingAsChange(listener)
    client.setActiveLayoutSessionId('perspective-a')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not fire on a redundant layout-session set to the same override', () => {
    const client = mkClient()
    client.setActiveLayoutSessionId('perspective-a')
    const listener = vi.fn()
    client.onActingAsChange(listener)
    client.setActiveLayoutSessionId('perspective-a')
    expect(listener).not.toHaveBeenCalled()
  })

  it('does not fire when a layout-session override folds to the current base id (null <-> base-id no-op)', () => {
    const client = mkClient()
    const listener = vi.fn()
    client.onActingAsChange(listener)
    // Explicitly overriding to the value the fallback already resolves to
    // is a no-op in EFFECTIVE terms, even though the raw field changed.
    client.setActiveLayoutSessionId('base-session-id')
    expect(listener).not.toHaveBeenCalled()
    // Clearing that override is likewise a no-op — still the base id.
    client.setActiveLayoutSessionId(null)
    expect(listener).not.toHaveBeenCalled()
  })

  it('fires once per effective change, independently per field', () => {
    const client = mkClient()
    const listener = vi.fn()
    client.onActingAsChange(listener)
    client.setActiveWorkspaceId('ws-1')
    client.setActiveLayoutSessionId('perspective-a')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('unsubscribe stops further notifications', () => {
    const client = mkClient()
    const listener = vi.fn()
    const unsubscribe = client.onActingAsChange(listener)
    unsubscribe()
    client.setActiveWorkspaceId('ws-1')
    client.setActiveLayoutSessionId('perspective-a')
    expect(listener).not.toHaveBeenCalled()
  })
})

import { describe, expect, it } from 'vitest'
import { resolveWorkspaceAccess } from './workspaceAccess.js'

describe('resolveWorkspaceAccess (§6 rule 3 — UI gate policy)', () => {
  it('plaintext pin → ready (server flag and key irrelevant)', () => {
    expect(resolveWorkspaceAccess('plaintext', 'none', false)).toEqual({ kind: 'ready' })
    // A hostile server flipping the flag to e2ee can't relock a plaintext pin.
    expect(resolveWorkspaceAccess('plaintext', 'e2ee', false)).toEqual({ kind: 'ready' })
  })

  it('e2ee pin with the WK loaded → ready', () => {
    expect(resolveWorkspaceAccess('e2ee', 'e2ee', true)).toEqual({ kind: 'ready' })
  })

  it('e2ee pin without the WK → locked, key-required (rule 3 locked)', () => {
    expect(resolveWorkspaceAccess('e2ee', 'e2ee', false)).toEqual({
      kind: 'locked',
      reason: 'key-required',
    })
  })

  it('unpinned + server says e2ee → locked, key-required (branch a, fail closed)', () => {
    expect(resolveWorkspaceAccess(null, 'e2ee', false)).toEqual({
      kind: 'locked',
      reason: 'key-required',
    })
  })

  it('unpinned + server says none → locked, quarantine (branch b — uncertain)', () => {
    expect(resolveWorkspaceAccess(null, 'none', false)).toEqual({
      kind: 'locked',
      reason: 'quarantine',
    })
  })
})

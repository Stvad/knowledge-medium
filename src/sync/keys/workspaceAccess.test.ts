import { describe, expect, it } from 'vitest'
import { decideWorkspaceEntry, resolveWorkspaceAccess } from './workspaceAccess.js'

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

describe('decideWorkspaceEntry (row-aware — guards the unsynced-row case)', () => {
  const noneRow = { encryptionMode: 'none' }
  const e2eeRow = { encryptionMode: 'e2ee' }

  it('decides WITHOUT the row when the pin settles it', () => {
    // plaintext pin → ready even before the row syncs (bootstrap is plaintext).
    expect(decideWorkspaceEntry('plaintext', false, null)).toEqual({ kind: 'ready' })
    // e2ee pin + WK loaded → ready (materialization uses the pin/key, not the row).
    expect(decideWorkspaceEntry('e2ee', true, null)).toEqual({ kind: 'ready' })
  })

  it('WAITS when the decision needs the row but it has not synced', () => {
    // unpinned: can't tell branch a from b without the server flag.
    expect(decideWorkspaceEntry(null, false, null)).toEqual({ kind: 'waiting' })
    // e2ee pin, no WK: needs the canary (in the row) to validate a paste.
    expect(decideWorkspaceEntry('e2ee', false, null)).toEqual({ kind: 'waiting' })
  })

  it('decides via the row once it is present', () => {
    expect(decideWorkspaceEntry(null, false, noneRow)).toEqual({ kind: 'locked', reason: 'quarantine' })
    expect(decideWorkspaceEntry(null, false, e2eeRow)).toEqual({ kind: 'locked', reason: 'key-required' })
    expect(decideWorkspaceEntry('e2ee', false, e2eeRow)).toEqual({ kind: 'locked', reason: 'key-required' })
    expect(decideWorkspaceEntry('plaintext', false, noneRow)).toEqual({ kind: 'ready' })
  })
})

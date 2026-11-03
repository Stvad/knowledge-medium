import { describe, expect, it } from 'vitest'
import { decideWorkspaceEntry, resolveWorkspaceAccess } from './workspaceAccess.js'

describe('resolveWorkspaceAccess (§6 rule 3 — UI gate policy)', () => {
  it('plaintext pin + server says none → ready (key irrelevant)', () => {
    expect(resolveWorkspaceAccess('plaintext', 'none', false)).toEqual({ kind: 'ready' })
    expect(resolveWorkspaceAccess('plaintext', 'none', true)).toEqual({ kind: 'ready' })
  })

  it('plaintext pin + server says e2ee → locked, server-e2ee (converted in place)', () => {
    // A false e2ee claim can only stall this device behind the gate — it never
    // makes it decrypt less — so the server is trusted in this direction.
    expect(resolveWorkspaceAccess('plaintext', 'e2ee', false)).toEqual({
      kind: 'locked',
      reason: 'server-e2ee',
    })
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

  it('unpinned + server says e2ee → locked, server-e2ee (branch a, fail closed)', () => {
    // Same gate as a converted plaintext pin: whether it may unlock now depends
    // on the conversion phase, which the gate reads from the server.
    expect(resolveWorkspaceAccess(null, 'e2ee', false)).toEqual({
      kind: 'locked',
      reason: 'server-e2ee',
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

  it('decides WITHOUT the row only for an e2ee pin with its WK', () => {
    // Materialization uses the pin/key and uploads seal via the pin, not the row.
    expect(decideWorkspaceEntry('e2ee', true, null)).toEqual({ kind: 'ready' })
  })

  it('a plaintext pin waits for the row: the server may have converted the workspace', () => {
    // Opening `ready` would let the bootstrap writes upload plaintext into an e2ee
    // workspace before its row arrives (after a local-DB reset, say), where the
    // ciphertext trigger refuses and quarantines them.
    expect(decideWorkspaceEntry('plaintext', false, null)).toEqual({ kind: 'waiting' })
  })

  it('WAITS when the decision needs the row but it has not synced', () => {
    // unpinned: can't tell branch a from b without the server flag.
    expect(decideWorkspaceEntry(null, false, null)).toEqual({ kind: 'waiting' })
    // e2ee pin, no WK: needs the canary (in the row) to validate a paste.
    expect(decideWorkspaceEntry('e2ee', false, null)).toEqual({ kind: 'waiting' })
  })

  it('decides via the row once it is present', () => {
    expect(decideWorkspaceEntry(null, false, noneRow)).toEqual({ kind: 'locked', reason: 'quarantine' })
    expect(decideWorkspaceEntry(null, false, e2eeRow)).toEqual({ kind: 'locked', reason: 'server-e2ee' })
    expect(decideWorkspaceEntry('e2ee', false, e2eeRow)).toEqual({ kind: 'locked', reason: 'key-required' })
    expect(decideWorkspaceEntry('plaintext', false, noneRow)).toEqual({ kind: 'ready' })
    expect(decideWorkspaceEntry('plaintext', false, e2eeRow)).toEqual({ kind: 'locked', reason: 'server-e2ee' })
  })
})

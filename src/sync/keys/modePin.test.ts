import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  arePinsSeeded,
  getModePin,
  seedModePinsOnce,
  setModePin,
} from './modePin.js'

const USER = 'user-1'
const WS_A = 'ws-A'
const WS_B = 'ws-B'

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe('mode pin', () => {
  it('returns null when never pinned', () => {
    expect(getModePin(USER, WS_A)).toBeNull()
  })

  it('round-trips a set pin', () => {
    setModePin(USER, WS_A, 'e2ee')
    expect(getModePin(USER, WS_A)).toBe('e2ee')
  })

  it('keys pins per (user, workspace)', () => {
    setModePin(USER, WS_A, 'e2ee')
    setModePin(USER, WS_B, 'plaintext')
    setModePin('user-2', WS_A, 'plaintext')
    expect(getModePin(USER, WS_A)).toBe('e2ee')
    expect(getModePin(USER, WS_B)).toBe('plaintext')
    expect(getModePin('user-2', WS_A)).toBe('plaintext')
  })

  it('re-pinning the same value is a no-op', () => {
    setModePin(USER, WS_A, 'e2ee')
    expect(() => setModePin(USER, WS_A, 'e2ee')).not.toThrow()
    expect(getModePin(USER, WS_A)).toBe('e2ee')
  })

  it('is immutable: flipping a pin throws (no silent downgrade)', () => {
    setModePin(USER, WS_A, 'e2ee')
    expect(() => setModePin(USER, WS_A, 'plaintext')).toThrow(/immutable/)
    expect(getModePin(USER, WS_A)).toBe('e2ee')
  })

  it('does not alias ids that share a delimiter', () => {
    // Without encoding, ('a', 'b:c') and ('a:b', 'c') would collide.
    setModePin('a', 'b:c', 'e2ee')
    expect(getModePin('a:b', 'c')).toBeNull()
  })
})

describe('rollout pin seed', () => {
  it('seeds unpinned memberships from the server mode, once', () => {
    const written = seedModePinsOnce(USER, [{ workspaceId: WS_A, serverMode: 'plaintext' }])
    expect(written).toBe(1)
    expect(getModePin(USER, WS_A)).toBe('plaintext')
    expect(arePinsSeeded(USER)).toBe(true)
  })

  it('never re-fires once seeded for this user (post-wipe safety)', () => {
    seedModePinsOnce(USER, [{ workspaceId: WS_A, serverMode: 'plaintext' }])
    // Simulate a later attempt (e.g. after a wipe recreated the DB): the
    // marker survives in localStorage, so the seed must not run again.
    const written = seedModePinsOnce(USER, [{ workspaceId: WS_B, serverMode: 'plaintext' }])
    expect(written).toBe(0)
    expect(getModePin(USER, WS_B)).toBeNull()
  })

  it('does not overwrite an existing pin', () => {
    setModePin(USER, WS_A, 'e2ee')
    seedModePinsOnce(USER, [{ workspaceId: WS_A, serverMode: 'plaintext' }])
    expect(getModePin(USER, WS_A)).toBe('e2ee')
  })

  it('still seeds a second user in the same browser profile (per-user marker)', () => {
    // localStorage is shared across accounts in a profile; user-1 seeding
    // must NOT block user-2's rollout seed (the bug a global marker caused).
    seedModePinsOnce(USER, [{ workspaceId: WS_A, serverMode: 'plaintext' }])
    expect(arePinsSeeded('user-2')).toBe(false)
    const written = seedModePinsOnce('user-2', [{ workspaceId: WS_A, serverMode: 'plaintext' }])
    expect(written).toBe(1)
    expect(getModePin('user-2', WS_A)).toBe('plaintext')
  })
})

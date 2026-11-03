// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearPinUpgradeMarker,
  confirmPlaintextForSession,
  getModePin,
  hasPinUpgradeMarker,
  setModePin,
  upgradeModePinToE2ee,
  writePinUpgradeMarker,
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

describe('session plaintext fallback', () => {
  it('session plaintext confirmation makes getModePin report plaintext (no persisted pin)', () => {
    // Degraded-storage fallback: a unique id so the in-memory set doesn't leak
    // into other tests (it isn't cleared by localStorage.clear()).
    const ws = 'ws-session-only'
    expect(getModePin(USER, ws)).toBeNull()
    confirmPlaintextForSession(USER, ws)
    expect(getModePin(USER, ws)).toBe('plaintext')
  })

  it('a persisted pin takes precedence over a session confirmation', () => {
    const ws = 'ws-session-precedence'
    setModePin(USER, ws, 'e2ee')
    confirmPlaintextForSession(USER, ws)
    expect(getModePin(USER, ws)).toBe('e2ee')
  })
})

describe('upgradeModePinToE2ee — the one transition the pin admits', () => {
  it('moves a plaintext pin to e2ee', () => {
    setModePin(USER, WS_A, 'plaintext')
    upgradeModePinToE2ee(USER, WS_A)
    expect(getModePin(USER, WS_A)).toBe('e2ee')
  })

  it('pins an unpinned workspace e2ee', () => {
    upgradeModePinToE2ee(USER, WS_A)
    expect(getModePin(USER, WS_A)).toBe('e2ee')
  })

  it('is a no-op on an e2ee pin', () => {
    setModePin(USER, WS_A, 'e2ee')
    upgradeModePinToE2ee(USER, WS_A)
    expect(getModePin(USER, WS_A)).toBe('e2ee')
  })

  it('outranks a session-only plaintext confirmation', () => {
    const ws = 'ws-session-upgrade'
    confirmPlaintextForSession(USER, ws)
    upgradeModePinToE2ee(USER, ws)
    expect(getModePin(USER, ws)).toBe('e2ee')
  })

  it('refuses the downgrade afterwards: setModePin cannot take an upgraded pin back to plaintext', () => {
    setModePin(USER, WS_A, 'plaintext')
    upgradeModePinToE2ee(USER, WS_A)
    expect(() => setModePin(USER, WS_A, 'plaintext')).toThrow(/immutable/)
    expect(getModePin(USER, WS_A)).toBe('e2ee')
  })
})

describe('pin upgrade marker', () => {
  it('is per (user, workspace) and clears', () => {
    expect(hasPinUpgradeMarker(USER, WS_A)).toBe(false)
    writePinUpgradeMarker(USER, WS_A)
    expect(hasPinUpgradeMarker(USER, WS_A)).toBe(true)
    expect(hasPinUpgradeMarker(USER, WS_B)).toBe(false)
    expect(hasPinUpgradeMarker('user-2', WS_A)).toBe(false)
    clearPinUpgradeMarker(USER, WS_A)
    expect(hasPinUpgradeMarker(USER, WS_A)).toBe(false)
  })

  it('does not read as a mode pin', () => {
    writePinUpgradeMarker(USER, WS_A)
    expect(getModePin(USER, WS_A)).toBeNull()
  })
})

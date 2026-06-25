import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isLoopbackBridgeUrl,
  processBridgePairingFromHash,
} from '../bridge.ts'
import {
  __resetDialogsForTests,
  getDialogQueue,
} from '@/utils/dialogs.js'

const bridgeUrlStorageKey = 'agent-runtime:bridge-url'
const bridgeSecretStorageKey = 'agent-runtime:bridge-secret'

const setHash = (hash: string) => {
  window.location.hash = hash
}

const pairingHash = (params: Record<string, string>) =>
  '#?' + Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')

/** The only pairing dialog the gate opens. Resolving it `true` is the
 *  user clicking "Pair"; resolving `null` (the queue's cancel value) is
 *  declining. */
const latestDialog = () => getDialogQueue().at(-1)

beforeEach(() => {
  window.localStorage.clear()
  __resetDialogsForTests()
  setHash('')
  vi.restoreAllMocks()
})

afterEach(() => {
  window.localStorage.clear()
  __resetDialogsForTests()
  setHash('')
})

describe('isLoopbackBridgeUrl', () => {
  it('accepts loopback hosts', () => {
    expect(isLoopbackBridgeUrl('http://127.0.0.1:8787')).toBe(true)
    expect(isLoopbackBridgeUrl('http://localhost:8787')).toBe(true)
    expect(isLoopbackBridgeUrl('http://[::1]:8787')).toBe(true)
    expect(isLoopbackBridgeUrl('https://127.0.0.1')).toBe(true)
  })

  it('rejects non-loopback hosts and junk', () => {
    expect(isLoopbackBridgeUrl('https://evil.example')).toBe(false)
    // host that merely embeds a loopback label
    expect(isLoopbackBridgeUrl('http://127.0.0.1.evil.example')).toBe(false)
    expect(isLoopbackBridgeUrl('http://localhost.evil.example')).toBe(false)
    // credential-host trick: userinfo looks loopback, real host isn't
    expect(isLoopbackBridgeUrl('http://127.0.0.1@evil.example')).toBe(false)
    expect(isLoopbackBridgeUrl('not a url')).toBe(false)
    expect(isLoopbackBridgeUrl('file:///etc/passwd')).toBe(false)
  })
})

describe('processBridgePairingFromHash — non-loopback URL', () => {
  it('never stores a non-loopback bridge URL or its smuggled secret', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setHash(pairingHash({
      'agent-runtime-url': 'https://evil.example',
      'agent-runtime-secret': 'attacker-secret',
    }))

    processBridgePairingFromHash()

    // Nothing persisted, and the attacker URL is refused outright — no
    // confirmation dialog is even offered for a non-loopback endpoint.
    expect(window.localStorage.getItem(bridgeUrlStorageKey)).toBeNull()
    expect(window.localStorage.getItem(bridgeSecretStorageKey)).toBeNull()
    expect(getDialogQueue()).toHaveLength(0)
    expect(warn).toHaveBeenCalled()

    // The credentials are stripped from the URL so they can't linger in
    // the address bar / history / referrer.
    expect(window.location.hash).toBe('')

    // Flush the deferred dialog scheduler: still nothing, even after a tick.
    await new Promise(r => window.setTimeout(r, 0))
    expect(window.localStorage.getItem(bridgeUrlStorageKey)).toBeNull()
    expect(window.localStorage.getItem(bridgeSecretStorageKey)).toBeNull()
    expect(getDialogQueue()).toHaveLength(0)
  })
})

describe('processBridgePairingFromHash — loopback URL', () => {
  it('does not persist until the user confirms the pairing dialog', async () => {
    setHash(pairingHash({
      'agent-runtime-url': 'http://127.0.0.1:8787',
      'agent-runtime-secret': 's3cr3t',
    }))

    processBridgePairingFromHash()

    // Hard gate: nothing written before the user acts.
    expect(window.localStorage.getItem(bridgeUrlStorageKey)).toBeNull()
    expect(window.localStorage.getItem(bridgeSecretStorageKey)).toBeNull()

    // The confirmation dialog is offered (deferred via setTimeout).
    await vi.waitFor(() => expect(latestDialog()).toBeTruthy())

    // User clicks "Pair".
    latestDialog()!.finalize(true)

    await vi.waitFor(() => {
      expect(window.localStorage.getItem(bridgeUrlStorageKey)).toBe('http://127.0.0.1:8787')
      expect(window.localStorage.getItem(bridgeSecretStorageKey)).toBe('s3cr3t')
    })
  })

  it('persists nothing if the user declines', async () => {
    setHash(pairingHash({
      'agent-runtime-url': 'http://localhost:9999',
      'agent-runtime-secret': 'nope',
    }))

    processBridgePairingFromHash()
    await vi.waitFor(() => expect(latestDialog()).toBeTruthy())

    // Cancel: the queue resolves declined dialogs with null.
    latestDialog()!.finalize(null)

    await new Promise(r => window.setTimeout(r, 0))
    expect(window.localStorage.getItem(bridgeUrlStorageKey)).toBeNull()
    expect(window.localStorage.getItem(bridgeSecretStorageKey)).toBeNull()
  })
})

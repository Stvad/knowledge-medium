import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isLoopbackBridgeUrl,
  processBridgePairingFromHash,
} from '../bridge.ts'
import {
  __resetDialogsForTests,
  getDialogQueue,
} from '@/utils/dialogs.js'
import { AgentTokensDialog } from '../AgentTokensDialog.tsx'
import { BridgePairingDialog } from '../BridgePairingDialog.tsx'

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

  it('confirming a loopback pairing with a non-default port stores that port', async () => {
    setHash(pairingHash({'agent-runtime-url': 'http://127.0.0.1:9999'}))

    processBridgePairingFromHash()
    await vi.waitFor(() => expect(latestDialog()).toBeTruthy())
    latestDialog()!.finalize(true)

    await vi.waitFor(() =>
      expect(window.localStorage.getItem(bridgeUrlStorageKey)).toBe('http://127.0.0.1:9999'),
    )
  })
})

describe('processBridgePairingFromHash — secret without a URL', () => {
  it('drops a lone secret: never stored, never prompted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Pre-existing legit secret the attacker should not be able to clobber.
    window.localStorage.setItem(bridgeSecretStorageKey, 'legit-secret')

    setHash(pairingHash({'agent-runtime-secret': 'attacker-secret'}))
    processBridgePairingFromHash()

    // No confirmation dialog is offered, and the stored secret is untouched.
    expect(getDialogQueue()).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
    expect(window.location.hash).toBe('')

    await new Promise(r => window.setTimeout(r, 0))
    expect(getDialogQueue()).toHaveLength(0)
    expect(window.localStorage.getItem(bridgeSecretStorageKey)).toBe('legit-secret')
  })

  it('still honors a co-supplied open-tokens request, without storing the secret', async () => {
    setHash(pairingHash({
      'agent-runtime-secret': 'attacker-secret',
      'agent-runtime-open-tokens': '1',
    }))
    processBridgePairingFromHash()

    // The benign token-minting dialog opens (it persists nothing on its
    // own); the smuggled secret is dropped, not the pairing-confirm dialog.
    await vi.waitFor(() => expect(latestDialog()?.Component).toBe(AgentTokensDialog))
    expect(latestDialog()?.Component).not.toBe(BridgePairingDialog)
    expect(window.localStorage.getItem(bridgeSecretStorageKey)).toBeNull()
  })
})

describe('processBridgePairingFromHash — open-tokens only', () => {
  it('opens the token dialog and stores nothing', async () => {
    setHash(pairingHash({'agent-runtime-open-tokens': '1'}))
    processBridgePairingFromHash()

    await vi.waitFor(() => expect(latestDialog()?.Component).toBe(AgentTokensDialog))
    expect(window.localStorage.getItem(bridgeUrlStorageKey)).toBeNull()
    expect(window.localStorage.getItem(bridgeSecretStorageKey)).toBeNull()
  })
})

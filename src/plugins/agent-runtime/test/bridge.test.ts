import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bridgeUrl,
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

/** Drain pending microtasks (e.g. an awaited `openDialog` continuation)
 *  deterministically — AGENTS.md forbids `setTimeout`-sleeping on async
 *  round trips, and a macrotask sleep is unnecessary here since the work
 *  we wait on is microtask-only. */
const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

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

    // FIFO fence (not a wall-clock sleep) to prove the refused URL
    // scheduled NO dialog, even against a future deferral regression:
    // fire a loopback pairing that DOES schedule a confirm dialog. Both
    // would schedule via the same setTimeout(0), so once the control's
    // dialog lands, in-order delivery proves the attacker URL queued none
    // — the queue holds only the control, and still nothing was persisted.
    setHash(pairingHash({'agent-runtime-url': 'http://127.0.0.1:8787'}))
    processBridgePairingFromHash()
    await vi.waitFor(() => expect(latestDialog()?.Component).toBe(BridgePairingDialog))
    expect(getDialogQueue()).toHaveLength(1)
    expect(window.localStorage.getItem(bridgeUrlStorageKey)).toBeNull()
    expect(window.localStorage.getItem(bridgeSecretStorageKey)).toBeNull()
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

    // Let confirmAndStorePairing's post-await continuation run: on decline
    // it must early-return without ever calling persistPairing.
    await flushMicrotasks()
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
  it('drops a lone secret: never stored, never prompted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Pre-existing legit secret the attacker should not be able to clobber.
    window.localStorage.setItem(bridgeSecretStorageKey, 'legit-secret')

    setHash(pairingHash({'agent-runtime-secret': 'attacker-secret'}))
    processBridgePairingFromHash()

    // The lone-secret branch is fully synchronous — it warns and schedules
    // nothing (no open-tokens here) — so this state is final: no dialog
    // offered, the hash stripped, and the existing secret left untouched.
    expect(getDialogQueue()).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
    expect(window.location.hash).toBe('')
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

describe('bridgeUrl — self-heals a poisoned persisted URL', () => {
  it('never returns a stored non-loopback URL and purges it + its secret', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Simulate a browser poisoned by the OLD pre-fix code: a non-loopback
    // attacker URL/secret already sitting in localStorage.
    window.localStorage.setItem(bridgeUrlStorageKey, 'https://evil.example')
    window.localStorage.setItem(bridgeSecretStorageKey, 'attacker-secret')

    const url = bridgeUrl()

    expect(url).not.toContain('evil.example')
    expect(isLoopbackBridgeUrl(url)).toBe(true)
    // Poisoned pairing is purged, so it can't be re-read on the next load.
    expect(window.localStorage.getItem(bridgeUrlStorageKey)).toBeNull()
    expect(window.localStorage.getItem(bridgeSecretStorageKey)).toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it('keeps a legitimate loopback stored URL', () => {
    window.localStorage.setItem(bridgeUrlStorageKey, 'http://127.0.0.1:9999')
    window.localStorage.setItem(bridgeSecretStorageKey, 'legit-secret')

    expect(bridgeUrl()).toBe('http://127.0.0.1:9999')
    expect(window.localStorage.getItem(bridgeUrlStorageKey)).toBe('http://127.0.0.1:9999')
    expect(window.localStorage.getItem(bridgeSecretStorageKey)).toBe('legit-secret')
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

// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceKeyGate, type WorkspaceGateDeps } from './WorkspaceKeyGate.tsx'
import { closeConversionFlow, conversionFlowTarget as conversionTarget } from './conversion/conversionFlowStore'
import { notifyWorkspaceUnlocked } from './workspaceUnlocked'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { getModePin, hasPinUpgradeMarker, setModePin, writePinUpgradeMarker } from '@/sync/keys/modePin'
import type { WorkspaceConversionState } from '@/sync/keys/conversionState'
import { mintCanary } from '@/sync/crypto/canary'
import { deriveContentKeyHmac } from '@/sync/crypto/contentKey'
import { formatWorkspaceKey, generateWorkspaceKeyBytes, importWorkspaceKey } from '@/sync/crypto/workspaceKey'

// The confirm-plaintext branch does real async work in onResolved (the host
// re-materializes the workspace's staged synced rows, then re-resolves to swap
// the gate for the app). On a freshly-wiped device that drain can take a while.
// These cover the feedback that work needs: the button must show progress
// (disabled) while in flight, ignore re-clicks, and recover with a message if
// onResolved rejects — otherwise the click looks dead and the user reloads.

const makeDeferred = () => {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const idleDeps: WorkspaceGateDeps = {
  drainWorkspace: async () => ({deferred: 0}),
  fetchConversionState: async () => ({kind: 'unavailable', error: new Error('not used')}),
  hasCopiedCiphertext: async () => false,
}

describe('WorkspaceKeyGate — confirm plaintext feedback', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('disables the confirm button while onResolved is in flight and ignores re-clicks', async () => {
    const deferred = makeDeferred()
    const onResolved = vi.fn(() => deferred.promise)
    render(
      <WorkspaceKeyGate
        userId="u1"
        workspaceId="w1"
        reason="quarantine"
        canary={null}
        deps={idleDeps}
        onResolved={onResolved}
      />,
    )
    const button = screen.getByRole('button', { name: /this workspace is not encrypted/i })

    await act(async () => {
      fireEvent.click(button)
    })

    expect(onResolved).toHaveBeenCalledTimes(1)
    expect(button).toBeDisabled()

    // A second click while the drain is in flight must not enqueue another one.
    fireEvent.click(button)
    expect(onResolved).toHaveBeenCalledTimes(1)
  })

  it('re-enables the button and surfaces the error when onResolved rejects', async () => {
    const deferred = makeDeferred()
    const onResolved = vi.fn(() => deferred.promise)
    render(
      <WorkspaceKeyGate
        userId="u1"
        workspaceId="w1"
        reason="quarantine"
        canary={null}
        deps={idleDeps}
        onResolved={onResolved}
      />,
    )
    const button = screen.getByRole('button', { name: /this workspace is not encrypted/i })

    await act(async () => {
      fireEvent.click(button)
    })
    expect(button).toBeDisabled()

    await act(async () => {
      deferred.reject(new Error('drain blew up'))
      await deferred.promise.catch(() => {})
    })

    expect(button).toBeEnabled()
    expect(screen.getByText('drain blew up')).toBeInTheDocument()
  })
})

describe('WorkspaceKeyGate — drains before handing back', () => {
  afterEach(() => cleanup())

  const renderWithDrain = (reason: 'key-required' | 'quarantine', canary: string | null) => {
    const order: string[] = []
    const deps = {...idleDeps, drainWorkspace: vi.fn(async () => { order.push('drain'); return {deferred: 0} })}
    const onResolved = vi.fn(async () => { order.push('resolved') })
    render(
      <WorkspaceKeyGate userId="u1" workspaceId="w1" reason={reason} canary={canary} deps={deps} onResolved={onResolved}/>,
    )
    return {order, onResolved}
  }

  it('an accepted key re-materializes the workspace, then re-resolves', async () => {
    window.localStorage.clear()
    const bytes = generateWorkspaceKeyBytes()
    const canary = await mintCanary(await importWorkspaceKey(bytes.slice()), 'w1')
    const {order, onResolved} = renderWithDrain('key-required', canary)
    fireEvent.change(screen.getByLabelText(/workspace key/i), {target: {value: formatWorkspaceKey(bytes)}})
    fireEvent.click(screen.getByRole('button', {name: /^unlock$/i}))
    await vi.waitFor(() => expect(onResolved).toHaveBeenCalled())
    expect(order).toEqual(['drain', 'resolved'])
  })

  it('a confirmed plaintext workspace re-materializes, then re-resolves', async () => {
    window.localStorage.clear()
    const {order, onResolved} = renderWithDrain('quarantine', null)
    fireEvent.click(screen.getByRole('button', {name: /this workspace is not encrypted/i}))
    await vi.waitFor(() => expect(onResolved).toHaveBeenCalled())
    expect(order).toEqual(['drain', 'resolved'])
  })
})

// The server says e2ee while this device's pin doesn't (docs/workspace-e2ee-conversion.md §6.2).
describe('WorkspaceKeyGate — server-e2ee', () => {
  const USER = 'owner-1'
  const WS = 'ws-converted'
  let wkString: string
  let canary: string
  let state: WorkspaceConversionState
  let deps: WorkspaceGateDeps & {drainWorkspace: ReturnType<typeof vi.fn<WorkspaceGateDeps['drainWorkspace']>>}
  let copied: boolean

  beforeEach(async () => {
    window.localStorage.clear()
    await getWorkspaceKeyStore().delete(USER, WS)
    const bytes = generateWorkspaceKeyBytes()
    wkString = formatWorkspaceKey(bytes)
    canary = await mintCanary(await importWorkspaceKey(bytes.slice()), WS)
    state = {encryptionMode: 'e2ee', conversionPhase: 'cleaning', wkCanary: canary, ownerUserId: USER}
    copied = false
    deps = {
      drainWorkspace: vi.fn<WorkspaceGateDeps['drainWorkspace']>(async () => ({deferred: 0})),
      fetchConversionState: vi.fn(async () => ({kind: 'read' as const, state})),
      hasCopiedCiphertext: async () => copied,
    }
    setModePin(USER, WS, 'plaintext')
  })
  afterEach(() => cleanup())

  const storeKey = async () => {
    const bytes = generateWorkspaceKeyBytes()
    const wk = await importWorkspaceKey(bytes.slice())
    canary = await mintCanary(wk, WS)
    state = {...state, wkCanary: canary}
    await getWorkspaceKeyStore().put(USER, WS, {wk, contentKeyHmac: await deriveContentKeyHmac(bytes.slice())})
  }

  const renderGate = (onResolved = vi.fn(async () => {})) => {
    render(
      <WorkspaceKeyGate
        userId={USER}
        workspaceId={WS}
        workspaceName="Vault"
        reason="server-e2ee"
        canary={null}
        deps={deps}
        onResolved={onResolved}
      />,
    )
    return onResolved
  }

  it('refuses to unlock while the server is sealing, on the converting device too', async () => {
    state = {...state, conversionPhase: 'sealing'}
    await storeKey() // the converting device holds the key it minted
    renderGate()
    expect(await screen.findByText(/is being encrypted/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/workspace key/i)).toBeNull()
    expect(screen.queryByRole('button', {name: /saved on this device/i})).toBeNull()
    expect(getModePin(USER, WS)).toBe('plaintext')
  })

  it('offers the owner, and only the owner, to continue the conversion while sealing', async () => {
    state = {...state, conversionPhase: 'sealing'}
    renderGate()
    fireEvent.click(await screen.findByRole('button', {name: /continue the conversion/i}))
    expect(conversionTarget()).toEqual({userId: USER, workspaceId: WS, workspaceName: 'Vault'})
    cleanup()
    closeConversionFlow()

    state = {...state, ownerUserId: 'someone-else'}
    renderGate()
    expect(await screen.findByText(/its owner is converting/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', {name: /continue the conversion/i})).toBeNull()
  })

  it('resolves when the conversion flow unlocks the workspace from outside the gate', async () => {
    state = {...state, conversionPhase: 'sealing'}
    const onResolved = renderGate()
    await screen.findByText(/is being encrypted/i)

    notifyWorkspaceUnlocked('another-workspace')
    expect(onResolved).not.toHaveBeenCalled()
    notifyWorkspaceUnlocked(WS)
    expect(onResolved).toHaveBeenCalledTimes(1)
  })

  it('a check that cannot reach the server offers no unlock, and checks again on request', async () => {
    let calls = 0
    deps = {
      ...deps,
      fetchConversionState: vi.fn(async () => (++calls === 1
        ? {kind: 'unavailable' as const, error: new TypeError('Failed to fetch')}
        : {kind: 'read' as const, state})),
    }
    renderGate()
    expect(await screen.findByText(/can't check/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/workspace key/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', {name: /check again/i}))
    expect(await screen.findByLabelText(/workspace key/i)).toBeInTheDocument()
  })

  it('a pasted key upgrades the pin, drains, then hands back to the host', async () => {
    const order: string[] = []
    deps.drainWorkspace.mockImplementation(async () => {
      order.push(`drain pin=${getModePin(USER, WS)}`)
      return {deferred: 0}
    })
    const onResolved = renderGate(vi.fn(async () => { order.push('resolved') }))

    fireEvent.change(await screen.findByLabelText(/workspace key/i), {target: {value: wkString}})
    fireEvent.click(screen.getByRole('button', {name: /^unlock$/i}))

    await vi.waitFor(() => expect(onResolved).toHaveBeenCalled())
    expect(order).toEqual(['drain pin=e2ee', 'resolved'])
    expect(hasPinUpgradeMarker(USER, WS)).toBe(false)
  })

  it('the converting device unlocks with the key it already holds, once past sealing', async () => {
    await storeKey()
    const onResolved = renderGate()
    fireEvent.click(await screen.findByRole('button', {name: /saved on this device/i}))
    await vi.waitFor(() => expect(onResolved).toHaveBeenCalled())
    expect(getModePin(USER, WS)).toBe('e2ee')
  })

  it('offers no saved-key unlock for a legacy record without K_id', async () => {
    await getWorkspaceKeyStore().put(USER, WS, {wk: {} as CryptoKey, contentKeyHmac: null})
    renderGate()
    await screen.findByLabelText(/workspace key/i)
    expect(screen.queryByRole('button', {name: /saved on this device/i})).toBeNull()
  })

  it('offers the owner to finish a conversion still cleaning up', async () => {
    renderGate()
    expect(await screen.findByText(/conversion hasn't finished/i)).toBeInTheDocument()
  })

  it('offers a member who is not the owner no finish', async () => {
    state = {...state, ownerUserId: 'someone-else'}
    renderGate()
    await screen.findByLabelText(/workspace key/i)
    expect(screen.queryByText(/conversion hasn't finished/i)).toBeNull()
  })

  it('a device that copied ciphertext is sent to the reset, not offered an unlock', async () => {
    copied = true
    renderGate()
    expect(await screen.findByText(/needs a reset/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/workspace key/i)).toBeNull()
  })

  it('the unlock re-reads the server at the click, and a sealing answer there refuses and shows it', async () => {
    renderGate()
    fireEvent.change(await screen.findByLabelText(/workspace key/i), {target: {value: wkString}})
    state = {...state, conversionPhase: 'sealing'}
    fireEvent.click(screen.getByRole('button', {name: /^unlock$/i}))
    expect(await screen.findByText(/is being encrypted/i)).toBeInTheDocument()
    expect(getModePin(USER, WS)).toBe('plaintext')
    expect(deps.drainWorkspace).not.toHaveBeenCalled()
  })
})

describe('WorkspaceKeyGate — finishing-upgrade', () => {
  const USER = 'owner-1'
  const WS = 'ws-converted'
  afterEach(() => cleanup())

  it('finishes an interrupted upgrade on mount, then hands back to the host', async () => {
    window.localStorage.clear()
    setModePin(USER, WS, 'e2ee')
    writePinUpgradeMarker(USER, WS)
    await getWorkspaceKeyStore().put(USER, WS, {wk: {} as CryptoKey, contentKeyHmac: {} as CryptoKey})
    const drainWorkspace = vi.fn(async () => ({deferred: 0}))
    const onResolved = vi.fn(async () => {})
    render(
      <WorkspaceKeyGate
        userId={USER}
        workspaceId={WS}
        reason="finishing-upgrade"
        canary={null}
        deps={{...idleDeps, drainWorkspace}}
        onResolved={onResolved}
      />,
    )
    await vi.waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1))
    expect(drainWorkspace).toHaveBeenCalledTimes(1)
    expect(hasPinUpgradeMarker(USER, WS)).toBe(false)
  })

  it('a drain that left rows deferred says so and offers a retry, rather than re-resolving into itself', async () => {
    window.localStorage.clear()
    setModePin(USER, WS, 'e2ee')
    writePinUpgradeMarker(USER, WS)
    await getWorkspaceKeyStore().put(USER, WS, {wk: {} as CryptoKey, contentKeyHmac: {} as CryptoKey})
    const drainWorkspace = vi.fn<WorkspaceGateDeps['drainWorkspace']>()
      .mockResolvedValueOnce({deferred: 2})
      .mockResolvedValueOnce({deferred: 0})
    const onResolved = vi.fn(async () => {})
    render(
      <WorkspaceKeyGate
        userId={USER}
        workspaceId={WS}
        reason="finishing-upgrade"
        canary={null}
        deps={{...idleDeps, drainWorkspace}}
        onResolved={onResolved}
      />,
    )
    expect(await screen.findByText(/couldn't be decrypted/i)).toBeInTheDocument()
    expect(onResolved).not.toHaveBeenCalled()
    expect(hasPinUpgradeMarker(USER, WS)).toBe(true)

    fireEvent.click(screen.getByRole('button', {name: /try again/i}))
    await vi.waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1))
    expect(hasPinUpgradeMarker(USER, WS)).toBe(false)
  })
})

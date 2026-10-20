// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BridgeHealthDiagnostics } from '../BridgeHealthDiagnostics.tsx'
import { readConfiguredBridgeUrl } from '../bridge.ts'

const originalPermissionsDescriptor = Object.getOwnPropertyDescriptor(navigator, 'permissions')
const bridgeUrlStorageKey = 'agent-runtime:bridge-url'
const bridgeSecretStorageKey = 'agent-runtime:bridge-secret'

beforeEach(() => {
  window.localStorage.removeItem(bridgeUrlStorageKey)
  window.localStorage.removeItem(bridgeSecretStorageKey)
})

afterEach(() => {
  cleanup()
  window.localStorage.removeItem(bridgeUrlStorageKey)
  window.localStorage.removeItem(bridgeSecretStorageKey)
  if (originalPermissionsDescriptor) {
    Object.defineProperty(navigator, 'permissions', originalPermissionsDescriptor)
  } else {
    Reflect.deleteProperty(navigator, 'permissions')
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('BridgeHealthDiagnostics', () => {
  it('reads the configured URL without purging or rewriting unsafe stored values', () => {
    const configuredUrl = 'http://127.0.0.1:8787/prefix?secret=URL_QUERY_SECRET#fragment'
    window.localStorage.setItem(bridgeUrlStorageKey, configuredUrl)
    expect(readConfiguredBridgeUrl()).toBe(configuredUrl)
    expect(window.localStorage.getItem(bridgeUrlStorageKey)).toBe(configuredUrl)

    const unsafeUrl = 'https://outside.example/private?secret=UNSAFE_URL_SECRET'
    const pairingSecret = 'PAIRING_SECRET_MARKER'
    window.localStorage.setItem(bridgeUrlStorageKey, unsafeUrl)
    window.localStorage.setItem(bridgeSecretStorageKey, pairingSecret)

    expect(readConfiguredBridgeUrl()).toBe(unsafeUrl)
    expect(window.localStorage.getItem(bridgeUrlStorageKey)).toBe(unsafeUrl)
    expect(window.localStorage.getItem(bridgeSecretStorageKey)).toBe(pairingSecret)
  })

  it('does nothing on render and probes standard then loopback only after their buttons are clicked', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ok: true})))
    const permissionQuery = vi.fn<(descriptor: {name: 'loopback-network'}) => Promise<{state: string}>>(async () => ({state: 'prompt'}))
    const bridgeUrl = vi.fn(() => 'http://127.0.0.1:8787/private?token=URL_SECRET_MARKER#fragment')
    vi.stubGlobal('fetch', fetchFn)
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: {query: permissionQuery},
    })

    render(<BridgeHealthDiagnostics getBridgeUrl={bridgeUrl} />)

    expect(fetchFn).not.toHaveBeenCalled()
    expect(permissionQuery).not.toHaveBeenCalled()
    expect(bridgeUrl).not.toHaveBeenCalled()
    expect(screen.getByRole('button', {name: 'Test /health'})).toBeTruthy()
    expect(screen.getByRole('button', {name: 'Test /health (loopback target)'})).toBeTruthy()

    fireEvent.click(screen.getByRole('button', {name: 'Test /health'}))
    const firstStatus = await screen.findByRole('status')
    expect(JSON.parse(firstStatus.textContent ?? '{}')).toMatchObject({
      mode: 'standard', status: 200, bodyOk: true,
    })
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe('http://127.0.0.1:8787/health')
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({credentials: 'omit', redirect: 'error'})
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toBeUndefined()
    expect(fetchFn.mock.calls[0]?.[1]?.body).toBeUndefined()
    expect(fetchFn.mock.calls[0]?.[1]).not.toHaveProperty('targetAddressSpace')
    expect(permissionQuery).toHaveBeenCalledTimes(1)
    expect(permissionQuery).toHaveBeenCalledWith({name: 'loopback-network'})

    fireEvent.click(screen.getByRole('button', {name: 'Test /health (loopback target)'}))
    await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(2))

    expect(String(fetchFn.mock.calls[1]?.[0])).toBe('http://127.0.0.1:8787/health')
    expect(fetchFn.mock.calls[1]?.[1]).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      targetAddressSpace: 'loopback',
    })
    expect(fetchFn.mock.calls[1]?.[1]?.headers).toBeUndefined()
    expect(fetchFn.mock.calls[1]?.[1]?.body).toBeUndefined()
    expect(permissionQuery).toHaveBeenCalledTimes(2)
    expect(permissionQuery).toHaveBeenNthCalledWith(1, {name: 'loopback-network'})
    expect(permissionQuery).toHaveBeenNthCalledWith(2, {name: 'loopback-network'})
    expect(screen.getAllByRole('status').map(node => node.textContent).join('\n'))
      .not.toContain('URL_SECRET_MARKER')
  })
})

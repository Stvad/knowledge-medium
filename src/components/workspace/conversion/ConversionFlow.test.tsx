// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { mintWorkspaceKey } from '@/sync/keys/mintWorkspaceKey'
import type { ConversionFlowDeps, ConversionUi } from '@/sync/conversion/runConversion'
import { seedPlaintext, WS } from '@/sync/conversion/test/conversionFixtures'
import { FakeConversionServer } from '@/sync/conversion/test/fakeConversionServer'
import { flowDeps, USER } from '@/sync/conversion/test/flowFixtures'
import { MemoryBundleFolder } from '@/sync/conversion/test/memoryBundleFolder'
import { ConversionFlow } from './ConversionFlow'
import type { ConversionUnavailable } from './conversionFlowDeps'

let server: FakeConversionServer
let keyStore: InMemoryWorkspaceKeyStore
let picked: MemoryBundleFolder

beforeEach(() => {
  server = new FakeConversionServer()
  seedPlaintext(server, 2)
  keyStore = new InMemoryWorkspaceKeyStore()
  picked = new MemoryBundleFolder('picked')
  vi.stubGlobal('showDirectoryPicker', async () => picked)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const renderFlow = (unavailable: ConversionUnavailable | null = null, overrides: Partial<ConversionFlowDeps> = {}) => {
  const makeDeps = (ui: ConversionUi, signal: AbortSignal) => flowDeps(server, ui, {keyStore, signal, ...overrides})
  return render(<ConversionFlow workspaceName="Vault" unavailable={unavailable} makeDeps={makeDeps} onClose={() => {}}/>)
}
const click = (name: RegExp) => fireEvent.click(screen.getByRole('button', {name}))
const flipped = async () => {
  const read = await server.conversionState(WS)
  return read.kind === 'read' && read.state.encryptionMode === 'e2ee'
}

const DONE = /attachments still need converting/i

/** Start, confirm the contract and the residue. */
const startToKeyStep = async () => {
  click(/^start$/i)
  fireEvent.click(await screen.findByLabelText(/every other device/i))
  click(/^continue$/i)
  fireEvent.click(await screen.findByLabelText(/i understand/i))
  click(/^continue$/i)
}

describe('ConversionFlow', () => {
  it('shows the new key once, and flips only after it is typed back', async () => {
    renderFlow()
    await startToKeyStep()

    const key = (await screen.findByTestId('workspace-key')).textContent!
    click(/i've saved it/i)
    expect(screen.queryByTestId('workspace-key')).toBeNull()

    fireEvent.change(screen.getByLabelText(/workspace key/i), {target: {value: `${key.slice(0, -2)}xx`}})
    click(/^confirm$/i)
    expect(await screen.findByText(/isn't the key shown/i)).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-key')).toBeNull()
    expect(await flipped()).toBe(false)

    fireEvent.change(screen.getByLabelText(/workspace key/i), {target: {value: key}})
    click(/^confirm$/i)

    // Past the flip: the bundle goes into a new folder inside the picked one.
    fireEvent.click(await screen.findByRole('button', {name: /choose a folder/i}))
    expect(await screen.findByText(DONE)).toBeInTheDocument()
    expect(await flipped()).toBe(true)
    expect(await keyStore.get(USER, WS)).not.toBeNull()
    expect(picked.folders.size).toBe(1)
  })

  it('offers no Stop while this device decrypts the workspace, which runs to its end', async () => {
    const minted = await mintWorkspaceKey(WS)
    await keyStore.put(USER, WS, minted.record)
    server.flip(WS, minted.canary)
    server.setPhase(WS, 'cleaning')
    let upgrade!: () => void
    renderFlow(undefined, {upgradePin: () => new Promise(resolve => (upgrade = () => resolve({ok: true})))})
    click(/^start$/i)
    fireEvent.click(await screen.findByLabelText(/every other device/i))
    click(/^continue$/i)

    expect(await screen.findByText(/decrypting the workspace on this device/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', {name: /stop/i})).toBeNull()
    upgrade()
  })

  it('offers no Stop while the flip request is out', async () => {
    let commit!: () => void
    const flip = server.convertWorkspaceToE2ee.bind(server)
    server.convertWorkspaceToE2ee = (workspaceId, canary) =>
      new Promise<void>(resolve => (commit = resolve)).then(() => flip(workspaceId, canary))
    renderFlow()
    await startToKeyStep()
    const key = (await screen.findByTestId('workspace-key')).textContent!
    click(/i've saved it/i)
    fireEvent.change(screen.getByLabelText(/workspace key/i), {target: {value: key}})
    click(/^confirm$/i)

    expect(await screen.findByText(/switching the server to encrypted mode/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', {name: /stop/i})).toBeNull()
    commit()
    expect(await screen.findByRole('button', {name: /choose a folder/i})).toBeInTheDocument()
  })

  it('asks for the earlier attempt\'s key, and makes a new one only on request', async () => {
    const earlier = await mintWorkspaceKey(WS)
    await keyStore.put(USER, WS, earlier.record)
    renderFlow()
    await startToKeyStep()

    expect(await screen.findByText(/key from an earlier attempt/i)).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-key')).toBeNull()
    click(/make a new key/i)

    expect((await screen.findByTestId('workspace-key')).textContent).not.toBe(earlier.displayed)
  })

  it('cancelling a prompt ends the run with nothing changed', async () => {
    renderFlow()
    click(/^start$/i)
    await screen.findByLabelText(/every other device/i)
    click(/^cancel$/i)

    expect(await screen.findByText(/^stopped/i)).toBeInTheDocument()
    expect(await flipped()).toBe(false)
    expect(server.calls.some(call => call.method === 'readBlockPage')).toBe(false)
  })

  it('offers no run where the conversion can\'t run', () => {
    renderFlow('no-server')

    expect(screen.getByText(/signed in and syncing/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', {name: /start/i})).toBeNull()
  })
})

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { mintWorkspaceKey } from '@/sync/keys/mintWorkspaceKey'
import { InMemoryBundleRecordStore } from '@/sync/conversion/bundle/bundleRecord'
import type { ConversionFlowDeps, ConversionUi } from '@/sync/conversion/runConversion'
import { seedMedia, seedPlaintext, WS } from '@/sync/conversion/test/conversionFixtures'
import { createFakeAttachmentStorage, type FakeAttachmentStorage } from '@/sync/conversion/test/fakeAttachmentStorage'
import { FakeConversionServer } from '@/sync/conversion/test/fakeConversionServer'
import { emptyBundleRecord, flowDeps, USER } from '@/sync/conversion/test/flowFixtures'
import { MemoryBundleFolder } from '@/sync/conversion/test/memoryBundleFolder'
import { ConversionFlow, PreflightPrompt } from './ConversionFlow'
import type { ConversionSetup } from './conversionFlowDeps'

let server: FakeConversionServer
let keyStore: InMemoryWorkspaceKeyStore
let picked: MemoryBundleFolder
let storage: FakeAttachmentStorage
let bundles: InMemoryBundleRecordStore

beforeEach(() => {
  server = new FakeConversionServer()
  seedPlaintext(server, 2)
  keyStore = new InMemoryWorkspaceKeyStore()
  picked = new MemoryBundleFolder('picked')
  storage = createFakeAttachmentStorage()
  bundles = new InMemoryBundleRecordStore()
  vi.stubGlobal('showDirectoryPicker', async () => picked)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const makeDeps = (ui: ConversionUi, signal: AbortSignal): ConversionFlowDeps =>
  flowDeps(server, ui, {keyStore, bundles, attachments: storage.io, signal})

const renderFlow = (setup: ConversionSetup = {kind: 'ready', makeDeps}) =>
  render(<ConversionFlow workspaceName="Vault" setup={setup} onClose={() => {}}/>)
const click = (name: RegExp) => fireEvent.click(screen.getByRole('button', {name}))
const flipped = async () => {
  const read = await server.conversionState(WS)
  return read.kind === 'read' && read.state.encryptionMode === 'e2ee'
}

const DONE = /this workspace is end-to-end encrypted/i

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
    fireEvent.click(await screen.findByRole('button', {name: /^finish$/i}))
    expect(await screen.findByText(DONE)).toBeInTheDocument()
    expect(await flipped()).toBe(true)
    expect(await keyStore.get(USER, WS)).not.toBeNull()
    expect(picked.folders.size).toBe(1)
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

  it('offers no Stop while the finish request is out', async () => {
    const minted = await mintWorkspaceKey(WS)
    await keyStore.put(USER, WS, minted.record)
    server.flip(WS, minted.canary)
    server.setPhase(WS, 'cleaning')
    await bundles.put(USER, WS, emptyBundleRecord())
    let commit!: () => void
    const finish = server.finishConversion.bind(server)
    server.finishConversion = workspaceId => new Promise<void>(resolve => (commit = resolve)).then(() => finish(workspaceId))
    renderFlow()
    click(/^start$/i)
    fireEvent.click(await screen.findByLabelText(/every other device/i))
    click(/^continue$/i)
    fireEvent.click(await screen.findByRole('button', {name: /^finish$/i}))

    expect(await screen.findByText(/finishing the conversion/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', {name: /stop/i})).toBeNull()
    commit()
    expect(await screen.findByText(DONE)).toBeInTheDocument()
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
    renderFlow({kind: 'unavailable', why: {kind: 'no-attachments', reason: 'the attachments plugin is off'}})

    expect(screen.getByText(/can't reach them: the attachments plugin is off/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', {name: /start/i})).toBeNull()
  })

  it('goes on past an attachment with no copy only once the user accepts its loss', async () => {
    const hash = await seedMedia(server, storage, {id: 'photo', bytes: new Uint8Array([1, 2, 3]), at: {}})
    renderFlow()
    click(/^start$/i)
    fireEvent.click(await screen.findByLabelText(/every other device/i))
    click(/^continue$/i)
    fireEvent.click(await screen.findByLabelText(/i understand/i))

    expect(screen.getByText(hash)).toBeInTheDocument()
    expect(screen.getByText('photo')).toBeInTheDocument()
    expect(screen.getByRole('button', {name: /^continue$/i})).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/bytes are lost/i))
    click(/^continue$/i)
    expect(await screen.findByTestId('workspace-key')).toBeInTheDocument()
  })

  it('lists what the cleanup left behind, and finishes only once the user accepts it', async () => {
    const minted = await mintWorkspaceKey(WS)
    await keyStore.put(USER, WS, minted.record)
    server.flip(WS, minted.canary)
    server.setPhase(WS, 'cleaning')
    await bundles.put(USER, WS, emptyBundleRecord())
    // Uploaded from outside the app after the bundle was taken.
    storage.objects.set('stray', new Uint8Array([9]))
    renderFlow()
    click(/^start$/i)
    fireEvent.click(await screen.findByLabelText(/every other device/i))
    click(/^continue$/i)

    expect(await screen.findByText('stray')).toBeInTheDocument()
    expect(screen.getByText(/the recovery bundle has no copy of it/i)).toBeInTheDocument()
    expect(screen.getByRole('button', {name: /^finish$/i})).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/with these left as they are/i))
    click(/^finish$/i)

    expect(await screen.findByText(DONE)).toBeInTheDocument()
    expect(storage.objects.has('stray')).toBe(true)
    expect(await bundles.get(USER, WS)).toBeNull()
  })
})

describe('PreflightPrompt', () => {
  it('goes on past an object too big to upload sealed only once the limits are raised', () => {
    const answer = vi.fn()
    const sealedBytes = 50 * 1024 * 1024 + 100
    render(<PreflightPrompt
      report={{
        sizes: {blockRows: 1, blocksBytes: 1, historyRows: 1, historyBytes: 1, localDbBytes: 1, attachmentBytes: 1, contentBytes: 1},
        oversized: [{what: 'sha256:big', sealedBytes}],
        noVerifiedSource: [],
      }}
      answer={answer}
      cancel={() => {}}
    />)
    fireEvent.click(screen.getByLabelText(/i understand/i))

    expect(screen.getByText('sha256:big')).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`at least .*\\(${sealedBytes} bytes\\)`))).toBeInTheDocument()
    expect(screen.getByRole('button', {name: /^continue$/i})).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/upload limits are raised/i))
    click(/^continue$/i)
    expect(answer).toHaveBeenCalledOnce()
  })
})

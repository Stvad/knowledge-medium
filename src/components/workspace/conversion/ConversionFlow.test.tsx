// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryWorkspaceKeyStore } from '@/sync/keys/keyStore'
import type { ConversionFlowDeps, ConversionUi } from '@/sync/conversion/runConversion'
import { seedPlaintext, WS } from '@/sync/conversion/test/conversionFixtures'
import { FakeConversionServer } from '@/sync/conversion/test/fakeConversionServer'
import { ConversionFlow } from './ConversionFlow'

const USER = 'user-1'

let server: FakeConversionServer
let keyStore: InMemoryWorkspaceKeyStore

beforeEach(() => {
  server = new FakeConversionServer()
  seedPlaintext(server, 2)
  keyStore = new InMemoryWorkspaceKeyStore()
})
afterEach(() => cleanup())

const makeDeps = (ui: ConversionUi, signal: AbortSignal): ConversionFlowDeps => ({
  userId: USER,
  workspaceId: WS,
  server,
  fetchConversionState: () => server.conversionState(WS),
  keyStore,
  lock: async (_name, run) => ({acquired: true, value: await run()}),
  preflight: {
    canPersistPins: () => true,
    keyStoreIsDurable: true,
    supportsDirectoryPicker: true,
    uploadQueue: async () => ({pending: 0, rejected: 0}),
  },
  markLocalConverted: async () => {},
  ui,
  signal,
})

const renderFlow = () => render(<ConversionFlow workspaceName="Vault" makeDeps={makeDeps} onClose={() => {}}/>)
const click = (name: RegExp) => fireEvent.click(screen.getByRole('button', {name}))
const flipped = async () => {
  const read = await server.conversionState(WS)
  return read.kind === 'read' && read.state.encryptionMode === 'e2ee'
}

describe('ConversionFlow', () => {
  it('shows the new key once, and flips only after it is typed back', async () => {
    renderFlow()
    click(/^start$/i)

    fireEvent.click(await screen.findByLabelText(/every other device/i))
    click(/^continue$/i)
    fireEvent.click(await screen.findByLabelText(/i understand/i))
    click(/create the key/i)

    const key = (await screen.findByTestId('conversion-key')).textContent!
    click(/i've saved it/i)
    expect(screen.queryByTestId('conversion-key')).toBeNull()

    fireEvent.change(screen.getByLabelText(/workspace key/i), {target: {value: `${key.slice(0, -2)}xx`}})
    click(/^confirm$/i)
    expect(await screen.findByText(/isn't the key shown/i)).toBeInTheDocument()
    expect(screen.queryByTestId('conversion-key')).toBeNull()
    expect(await flipped()).toBe(false)

    fireEvent.change(screen.getByLabelText(/workspace key/i), {target: {value: key}})
    click(/^confirm$/i)

    expect(await screen.findByText(/aren't available in this version/i)).toBeInTheDocument()
    expect(await flipped()).toBe(true)
    expect(await keyStore.get(USER, WS)).not.toBeNull()
  })

  it('cancelling a prompt ends the run with nothing changed', async () => {
    renderFlow()
    click(/^start$/i)
    await screen.findByLabelText(/every other device/i)
    click(/^cancel$/i)

    expect(await screen.findByText(/^stopped/i)).toBeInTheDocument()
    expect(await flipped()).toBe(false)
    expect(server.calls.some(call => call.method === 'readEnvelopePrefixedPage')).toBe(false)
  })
})

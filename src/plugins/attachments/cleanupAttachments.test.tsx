// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo.js'
import type { WorkspaceConversionRead } from '@/sync/keys/conversionState.js'
import type { CleanerReport } from '@/sync/conversion/attachmentCleaner.js'

const h = vi.hoisted(() => ({
  remote: true,
  fetchState: 0,
  read: null as unknown as WorkspaceConversionRead,
  record: null as {wk: CryptoKey; contentKeyHmac: CryptoKey | null} | null,
  clean: vi.fn(),
  readObject: vi.fn(),
}))
vi.mock('@/data/workspaceConversion.js', () => ({
  fetchWorkspaceConversionState: async () => {
    h.fetchState++
    return h.read
  },
}))
vi.mock('@/sync/keys/keyStore.js', async orig => ({
  ...(await orig<typeof import('@/sync/keys/keyStore.js')>()),
  getWorkspaceKeyStore: () => ({get: async () => h.record}),
}))
vi.mock('@/services/supabase.js', () => ({supabase: {}}))
vi.mock('./assetUpload.js', () => ({getBlobStore: () => ({})}))
vi.mock('@/data/repoProvider.js', () => ({isRemoteSyncActive: () => h.remote}))
vi.mock('./cleanerIO.js', () => ({cleanerIOFor: () => ({kind: 'ready', io: {readObject: h.readObject}})}))
vi.mock('@/sync/conversion/attachmentCleaner.js', async orig => ({
  ...(await orig<typeof import('@/sync/conversion/attachmentCleaner.js')>()),
  cleanAttachments: h.clean,
}))

const {prepareCleanup} = await import('./cleanupAttachments.js')
const {CleanupAttachmentsDialog} = await import('./CleanupAttachmentsDialog.js')

const USER = 'owner-1'
const WS = 'ws-1'
const repo = {user: {id: USER}} as unknown as Repo
const key = {} as CryptoKey
const e2ee = (
  over: Partial<{encryptionMode: string; ownerUserId: string; wkCanary: string | null; conversionPhase: 'sealing' | 'cleaning' | null}> = {},
) =>
  ({
    kind: 'read',
    state: {encryptionMode: 'e2ee', conversionPhase: null, wkCanary: 'enc:v1:canary', ownerUserId: USER, ...over},
  }) as WorkspaceConversionRead

const report = (over: Partial<CleanerReport> = {}): CleanerReport => ({
  converted: [],
  refused: [],
  deleted: [],
  left: [],
  rebuilt: [],
  errors: [],
  bundleFault: null,
  proof: {kind: 'passed', unrecoverable: []},
  ...over,
})

beforeEach(() => {
  h.remote = true
  h.fetchState = 0
  h.read = e2ee()
  h.record = {wk: key, contentKeyHmac: key}
  h.clean.mockReset()
  h.readObject.mockReset()
})
afterEach(cleanup)

describe('prepareCleanup', () => {
  it('runs the cleaner for the owner of an unlocked e2ee workspace, with no bundle', async () => {
    h.clean.mockResolvedValue(report())
    const run = await prepareCleanup(repo, WS)
    expect(typeof run).toBe('function')
    if (typeof run === 'string') return
    expect(await run(() => {}, new AbortController().signal)).toEqual(report())
    expect(h.clean).toHaveBeenCalledWith(
      expect.objectContaining({workspaceId: WS, keys: {cek: key, contentKeyHmac: key}, canary: 'enc:v1:canary', bundle: null}),
    )
  })

  it('refuses a member who is not the owner, a plaintext workspace, a locked one, and an unreadable server', async () => {
    const cases: [() => void, RegExp][] = [
      [() => (h.read = e2ee({ownerUserId: 'someone-else'})), /owner/],
      [() => (h.read = e2ee({encryptionMode: 'none'})), /end-to-end encrypted/],
      [() => (h.record = null), /Unlock/],
      [() => (h.record = {wk: key, contentKeyHmac: null}), /Unlock/],
      [() => (h.read = {kind: 'unavailable', error: new Error('offline')}), /server/],
      [() => (h.read = e2ee({conversionPhase: 'sealing'})), /being converted/],
      [() => (h.read = e2ee({conversionPhase: 'cleaning'})), /being converted/],
    ]
    for (const [arrange, message] of cases) {
      h.read = e2ee()
      h.record = {wk: key, contentKeyHmac: key}
      arrange()
      expect(await prepareCleanup(repo, WS)).toMatch(message)
    }
    expect(h.clean).not.toHaveBeenCalled()
  })
})

describe('prepareCleanup in local-only mode', () => {
  it('refuses without a single server request', async () => {
    h.remote = false
    expect(await prepareCleanup(repo, WS)).toMatch(/remote sync/)
    expect(h.fetchState).toBe(0)
  })
})

describe('prepareCleanup, inside the lock', () => {
  it('reads the server and the key again when the run starts: a re-key or a conversion while the dialog was open stops it', async () => {
    const run = await prepareCleanup(repo, WS)
    if (typeof run === 'string') throw new Error(run)
    h.read = e2ee({conversionPhase: 'sealing'})
    await expect(run(() => {}, new AbortController().signal)).rejects.toThrow(/being converted/)
    h.read = e2ee({wkCanary: 'enc:v1:a-new-canary'})
    h.clean.mockResolvedValue(report())
    await run(() => {}, new AbortController().signal)
    expect(h.clean).toHaveBeenCalledTimes(1)
    expect(h.clean).toHaveBeenCalledWith(expect.objectContaining({canary: 'enc:v1:a-new-canary'}))
  })
})

describe('prepareCleanup, stopped', () => {
  it("ends the pass's stalled Storage calls", async () => {
    h.readObject.mockReturnValue(new Promise(() => {}))
    h.clean.mockImplementation(({io}: {io: {readObject: (path: string) => Promise<unknown>}}) => io.readObject('ws/a'))
    const run = await prepareCleanup(repo, WS)
    if (typeof run === 'string') throw new Error(run)
    const stop = new AbortController()

    const running = run(() => {}, stop.signal)
    let settled = false
    void running.catch(() => {}).finally(() => { settled = true })
    await vi.waitFor(() => expect(h.readObject).toHaveBeenCalled())
    stop.abort(new DOMException('stopped', 'AbortError'))

    await vi.waitFor(() => expect(settled).toBe(true))
    await expect(running).rejects.toThrow('stopped')
  })
})

describe('CleanupAttachmentsDialog', () => {
  it('runs only when asked, then shows what the pass did and what is still waiting', async () => {
    const run = vi.fn().mockResolvedValue(
      report({
        converted: ['aa'],
        refused: [{path: 'bb', status: 413, sealedBytes: 52_428_837}],
        proof: {kind: 'not-passed', rawRemaining: ['bb'], archivedRemaining: [], unverified: [], unsettled: false},
      }),
    )
    render(<CleanupAttachmentsDialog run={run} resolve={() => {}} cancel={() => {}} />)
    expect(run).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', {name: 'Clean up'}))
    expect(await screen.findByText(/not stored encrypted yet/)).toBeTruthy()
    expect(screen.getByText(/Encrypted 1 plaintext file\./)).toBeTruthy()
    expect(screen.getByText(/Raise the project.s Storage upload limit.*at least 52,428,837 bytes/)).toBeTruthy()
  })

  it('says when another tab is already running it', async () => {
    render(<CleanupAttachmentsDialog run={async () => 'busy'} resolve={() => {}} cancel={() => {}} />)
    fireEvent.click(screen.getByRole('button', {name: 'Clean up'}))
    expect(await screen.findByText(/already running in another tab/)).toBeTruthy()
  })
})

// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createElement, type ComponentType} from 'react'
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react'
import * as toast from '@/utils/toast.js'
import {RepoContext} from '@/context/repo.js'
import type {Repo} from '@/data/repo.js'
import {diagnosticsFacet, type DiagnosticSourceContribution} from '@/plugins/diagnostics/facet.js'

const {createClient, authedRequest, dailyNote} = vi.hoisted(() => {
  const authedRequest = vi.fn()
  return {authedRequest, createClient: vi.fn(() => ({http: {authedRequest}})), dailyNote: vi.fn()}
})
vi.mock('https://esm.sh/matrix-js-sdk@38.0.0?bundle', () => ({createClient}))
vi.mock('@/plugins/daily-notes/index.js', async importOriginal => ({
  ...await importOriginal<typeof import('@/plugins/daily-notes/index.js')>(),
  getOrCreateDailyNote: dailyNote,
}))
vi.mock('@/data/stateBlocks.js', () => ({
  pluginPrefsBlockId: (workspaceId: string) => workspaceId,
  getPluginPrefsBlock: async (repo: ReturnType<typeof makeRepo>, workspaceId: string) => repo.prefs.get(workspaceId),
}))

import contributions, {
  autoStartProp, homeserverProp, matrixIngestEffect,
  nextBatchKey, pollLoop, roomIdProp, tokenKey,
} from './matrix-chat-client.tsx'

const a = {workspaceId: 'first', baseUrl: 'https://matrix.test', roomId: '!local:matrix.test'}
const otherWorkspace = {...a, workspaceId: 'second'}
const legacyBaseUrl = 'https://MATRIX.test:443/prefix/'
const legacyConfigKey = 'knowledge-medium:matrix-messages:config:v1'
const legacyTokenKey = 'knowledge-medium:matrix:token:v1'
const legacyCursorKey = `knowledge-medium:matrix-messages:state:v1:${legacyBaseUrl.slice(0, -1)}:${a.roomId}`
const workspaceName = 'Fixture workspace'
const cursorState = (nextBatch: string) => JSON.stringify({nextBatch, savedAt: 1})
const diagnostics = contributions.find(c => c.facet.id === diagnosticsFacet.id)!.value as DiagnosticSourceContribution

function makePrefs(workspaceId: string) {
  const values = new Map<string, unknown>([
    [homeserverProp.name, a.baseUrl], [roomIdProp.name, a.roomId], [autoStartProp.name, true],
  ])
  const data = {workspaceId}
  const listeners = new Set<(row: typeof data) => void>()
  return {
    id: workspaceId, data,
    load: async () => data,
    peek: () => data,
    get: (prop: {name: string}) => values.get(prop.name),
    set(prop: {name: string}, value: unknown) {
      if (values.get(prop.name) === value) return
      values.set(prop.name, value)
      listeners.forEach(notify => notify(data))
    },
    subscribe(notify: (row: typeof data) => void) {
      listeners.add(notify)
      return () => { listeners.delete(notify) }
    },
  }
}

function makeRepo() {
  const prefs = new Map([a, otherWorkspace].map(d => [d.workspaceId, makePrefs(d.workspaceId)]))
  const listeners = new Set<() => void>()
  return {
    activeWorkspaceId: a.workspaceId, user: {id: 'fixture-user'}, prefs, block: (id: string) => prefs.get(id),
    db: {
      getAll: async () => [],
      getOptional: async (_sql: string, [id]: string[]) => id === a.workspaceId ? {name: workspaceName} : null,
    },
    tx: vi.fn(async (run: (tx: {setProperty: (id: string, prop: {name: string}, value: unknown) => void}) => Promise<void>) => {
      await run({setProperty: (id, prop, value) => prefs.get(id)!.set(prop, value)})
    }),
    client: {
      onActingAsChange(listener: () => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    setActiveWorkspaceId(id: string) {
      this.activeWorkspaceId = id
      listeners.forEach(notify => notify())
    },
  }
}

function openSetup(repo: ReturnType<typeof makeRepo>) {
  const connect = contributions.find(c => (c.value as {id?: string}).id === 'matrix.connect')!.value as unknown as {handler: () => void}
  const mount = contributions.find(c => (c.value as {id?: string}).id === 'matrix.setup-dialog')!.value as {component: ComponentType}
  render(createElement(RepoContext.Provider, {value: repo as unknown as Repo}, createElement(mount.component)))
  act(() => connect.handler())
}

function expectDestination() {
  const text = screen.getByRole('dialog').textContent
  expect(text).toContain(a.baseUrl)
  expect(text).toContain(a.roomId)
  expect(text).toContain(workspaceName)
}

async function correctLegacyOrigin() {
  const input = await screen.findByDisplayValue(legacyBaseUrl)
  expect((screen.getByRole('button', {name: 'Save'}) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(input, {target: {value: a.baseUrl}})
}
let stop: (() => void) | undefined
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  authedRequest.mockImplementation(() => new Promise(() => {}))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  stop?.()
  stop = undefined
  localStorage.clear()
})

describe('Matrix device authorization', () => {
  it.each([
    ['homeserver', {...a, baseUrl: 'https://other.test'}],
    ['room', {...a, roomId: '!other:matrix.test'}],
    ['workspace', otherWorkspace],
  ] as const)('reports a missing token and skips polling after a %s change', async (_field, changed) => {
    const repo = makeRepo()
    localStorage.setItem(tokenKey(a), 'bound-token')
    stop = matrixIngestEffect.start({repo})
    await vi.waitFor(() => expect(createClient).toHaveBeenCalledWith({baseUrl: a.baseUrl, accessToken: 'bound-token'}))
    expect(diagnostics.getSnapshot()).toBeNull()
    const signal = authedRequest.mock.calls[0][4].abortSignal as AbortSignal
    expect(signal.aborted).toBe(false)
    if (changed.workspaceId !== repo.activeWorkspaceId) {
      repo.setActiveWorkspaceId(changed.workspaceId)
    } else {
      const prefs = repo.prefs.get(changed.workspaceId)!
      prefs.set(homeserverProp, changed.baseUrl)
      prefs.set(roomIdProp, changed.roomId)
    }
    await vi.waitFor(() => expect(diagnostics.getSnapshot()?.summary).toBe('Matrix token is missing'))
    expect(signal.aborted).toBe(true)
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(authedRequest).toHaveBeenCalledTimes(1)
  })

  it.each(['unscoped token', 'legacy config'] as const)(
    'keeps the %s pending until explicit bind and resumes its original cursor', async source => {
      const repo = makeRepo()
      const prefs = repo.prefs.get(a.workspaceId)!
      const reads = vi.spyOn(prefs, 'get')
      const blobPrefs = {baseUrl: legacyBaseUrl, roomId: source === 'legacy config' ? a.roomId : '!other:matrix.test', customSetting: {flag: true}}
      const embedded = source === 'unscoped token' ? 'another-token' : 'pending-token'
      localStorage.setItem(legacyConfigKey, JSON.stringify({...blobPrefs, accessToken: embedded}))
      if (source === 'unscoped token') {
        prefs.set(homeserverProp, legacyBaseUrl)
        localStorage.setItem(legacyTokenKey, 'pending-token')
      } else {
        prefs.set(roomIdProp, '')
      }
      localStorage.setItem(legacyCursorKey, cursorState('prior-position'))
      stop = matrixIngestEffect.start({repo})
      await vi.waitFor(() => {
        expect(reads).toHaveBeenCalledWith(autoStartProp)
        expect(localStorage.getItem(legacyTokenKey)).toBe('pending-token')
        expect(diagnostics.getSnapshot()?.summary).toBe('Matrix ingest is not configured')
      })
      expect(JSON.parse(localStorage.getItem(legacyConfigKey)!)).toEqual({...blobPrefs, accessToken: embedded})
      expect(createClient).not.toHaveBeenCalled()
      expect(localStorage.getItem(nextBatchKey(a))).toBeNull()
      openSetup(repo)
      await correctLegacyOrigin()
      const bind = await screen.findByRole('button', {name: 'Bind saved device token'})
      expectDestination()
      fireEvent.click(bind)
      await vi.waitFor(() => expect(authedRequest).toHaveBeenCalled())
      expect(createClient).toHaveBeenCalledWith({baseUrl: a.baseUrl, accessToken: 'pending-token'})
      expect(authedRequest.mock.calls[0][2].since).toBe('prior-position')
      expect(localStorage.getItem(legacyTokenKey)).toBeNull()
      expect(JSON.parse(localStorage.getItem(legacyConfigKey)!)).toEqual(blobPrefs)
      expect(localStorage.getItem(legacyCursorKey)).toBe(cursorState('prior-position'))
      expect(prefs.get(homeserverProp)).toBe(a.baseUrl)
      expect(localStorage.getItem(nextBatchKey(otherWorkspace))).toBeNull()
      expect(localStorage.getItem(tokenKey(otherWorkspace))).toBeNull()
    },
  )

  it('shows the authorized destination when saving a newly entered token', async () => {
    const repo = makeRepo()
    const prefs = repo.prefs.get(a.workspaceId)!
    prefs.set(homeserverProp, legacyBaseUrl)
    localStorage.setItem(legacyCursorKey, cursorState('previous'))
    localStorage.setItem(legacyTokenKey, 'unselected-token')
    openSetup(repo)
    await correctLegacyOrigin()
    fireEvent.change(screen.getByLabelText('Access token'), {target: {value: 'new-token'}})
    expectDestination()
    fireEvent.click(screen.getByRole('button', {name: 'Save'}))
    await vi.waitFor(() => expect(localStorage.getItem(tokenKey(a))).toBe('new-token'))
    expect(localStorage.getItem(nextBatchKey(a))).toBe(cursorState('previous'))
    expect(localStorage.getItem(legacyCursorKey)).toBe(cursorState('previous'))
    expect(localStorage.getItem(legacyTokenKey)).toBeNull()
  })

  it('keeps a reset position when the pair still has a legacy checkpoint', async () => {
    const repo = makeRepo()
    localStorage.setItem(legacyTokenKey, 'pending-token')
    localStorage.setItem(legacyCursorKey, cursorState('previous'))
    localStorage.setItem(nextBatchKey(a), cursorState('current'))
    const reset = contributions.find(c => (c.value as {id?: string}).id === 'matrix.reset-position')!.value as unknown as {
      handler: (ctx: {uiStateBlock: {repo: ReturnType<typeof makeRepo>}}) => Promise<void>
    }
    await reset.handler({uiStateBlock: {repo}})
    openSetup(repo)
    fireEvent.click(await screen.findByRole('button', {name: 'Bind saved device token'}))
    await vi.waitFor(() => expect(localStorage.getItem(tokenKey(a))).toBe('pending-token'))
    expect(JSON.parse(localStorage.getItem(nextBatchKey(a))!).nextBatch).toBeNull()
    expect(localStorage.getItem(legacyCursorKey)).toBe(cursorState('previous'))
  })

  it('preserves an existing scoped checkpoint when binding the saved token', async () => {
    const repo = makeRepo()
    repo.prefs.get(a.workspaceId)!.set(homeserverProp, legacyBaseUrl)
    localStorage.setItem(legacyTokenKey, 'pending-token')
    localStorage.setItem(legacyCursorKey, cursorState('previous'))
    localStorage.setItem(nextBatchKey(a), cursorState('current'))
    openSetup(repo)
    await correctLegacyOrigin()
    fireEvent.click(await screen.findByRole('button', {name: 'Bind saved device token'}))
    await vi.waitFor(() => expect(localStorage.getItem(tokenKey(a))).toBe('pending-token'))
    expect(localStorage.getItem(nextBatchKey(a))).toBe(cursorState('current'))
  })

  it.each([
    ['another origin', {...a, baseUrl: 'https://other.test'}],
    ['another room', {...a, roomId: '!other:matrix.test'}],
  ] as const)('withholds pending bind when local evidence names %s', async (_, elsewhere) => {
    const repo = makeRepo()
    localStorage.setItem(legacyTokenKey, 'pending')
    localStorage.setItem(legacyConfigKey, JSON.stringify({...elsewhere, accessToken: 'pending'}))
    localStorage.setItem(`knowledge-medium:matrix-messages:state:v1:${elsewhere.baseUrl}:${elsewhere.roomId}`, cursorState('elsewhere'))
    openSetup(repo)
    await screen.findByDisplayValue(a.roomId)
    expectDestination()
    const bind = screen.queryByRole('button', {name: 'Bind saved device token'}) as HTMLButtonElement | null
    expect(bind === null || bind.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', {name: 'Save'}))
    expect(localStorage.getItem(tokenKey(a))).toBeNull()
    expect(localStorage.getItem(legacyTokenKey)).toBe('pending')
  })

  it('withholds pending bind when the only matching pair belongs to a different token', async () => {
    const repo = makeRepo()
    localStorage.setItem(legacyTokenKey, 'pending')
    localStorage.setItem(legacyConfigKey, JSON.stringify({...a, accessToken: 'different'}))
    openSetup(repo)
    await screen.findByDisplayValue(a.roomId)
    expectDestination()
    const bind = screen.queryByRole('button', {name: 'Bind saved device token'}) as HTMLButtonElement | null
    expect(bind === null || bind.disabled).toBe(true)
  })

  it('requires the selected legacy token to remain eligible until binding', async () => {
    const repo = makeRepo()
    localStorage.setItem(legacyTokenKey, 'pending')
    localStorage.setItem(legacyCursorKey, cursorState('old'))
    const error = vi.spyOn(toast, 'showError')
    const persist = repo.tx.getMockImplementation()!
    repo.tx.mockImplementationOnce(async run => {
      await persist(run)
      localStorage.removeItem(legacyCursorKey)
    })
    openSetup(repo)
    fireEvent.click(await screen.findByRole('button', {name: 'Bind saved device token'}))
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('Reopen Matrix settings')))
    expect(localStorage.getItem(tokenKey(a))).toBeNull()
    expect(localStorage.getItem(legacyTokenKey)).toBe('pending')
  })

  it('resumes the legacy cursor when another device already normalized the synced origin', async () => {
    const repo = makeRepo()
    localStorage.setItem(legacyTokenKey, 'pending')
    localStorage.setItem(legacyCursorKey, cursorState('old'))
    openSetup(repo)
    fireEvent.click(await screen.findByRole('button', {name: 'Bind saved device token'}))
    await vi.waitFor(() => expect(localStorage.getItem(tokenKey(a))).toBe('pending'))
    expect(localStorage.getItem(nextBatchKey(a))).toBe(cursorState('old'))
    expect(localStorage.getItem(legacyCursorKey)).toBe(cursorState('old'))
  })

  it('refuses a synced path when a token is bound to the origin', async () => {
    const repo = makeRepo()
    localStorage.setItem(tokenKey(a), 'bound-token')
    stop = matrixIngestEffect.start({repo})
    await vi.waitFor(() => expect(authedRequest).toHaveBeenCalledOnce())
    const signal = authedRequest.mock.calls[0][4].abortSignal as AbortSignal
    repo.prefs.get(a.workspaceId)!.set(homeserverProp, legacyBaseUrl)
    expect(signal.aborted).toBe(true)
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(diagnostics.getSnapshot()?.summary).toBe('Matrix ingest is not configured')
  })

  it('rejects malformed cursor evidence even when other rooms have current and historical cursors', async () => {
    const repo = makeRepo()
    localStorage.setItem(legacyTokenKey, 'pending')
    const prefix = 'knowledge-medium:matrix-messages:state:v1:'
    const historical = legacyBaseUrl.slice(0, -1)
    localStorage.setItem(prefix + a.baseUrl + ':' + a.roomId, '{invalid')
    localStorage.setItem(prefix + historical + ':' + a.roomId, JSON.stringify({nextBatch: 5}))
    for (const base of [a.baseUrl, historical]) {
      localStorage.setItem(prefix + base + ':!other:matrix.test', cursorState('elsewhere'))
    }
    openSetup(repo)
    await screen.findByDisplayValue(a.roomId)
    expectDestination()
    const bind = screen.queryByRole('button', {name: 'Bind saved device token'}) as HTMLButtonElement | null
    expect(bind === null || bind.disabled).toBe(true)
    expect(localStorage.getItem(legacyTokenKey)).toBe('pending')
    expect(localStorage.getItem(nextBatchKey(a))).toBeNull()
  })

  it('requires an origin before authorizing a newly entered token', async () => {
    const repo = makeRepo()
    openSetup(repo)
    await screen.findByDisplayValue(a.roomId)
    fireEvent.change(screen.getByLabelText('Access token'), {target: {value: 'new-token'}})
    fireEvent.change(screen.getByLabelText('Homeserver URL'), {target: {value: legacyBaseUrl}})
    const save = screen.getByRole('button', {name: 'Save'}) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(repo.tx).not.toHaveBeenCalled()
    expect(localStorage.getItem(tokenKey(a))).toBeNull()
  })

  it('offers a saved token for its legacy config pair without a cursor', async () => {
    const repo = makeRepo()
    localStorage.setItem(legacyTokenKey, 'pending')
    localStorage.setItem(legacyConfigKey, JSON.stringify({...a, accessToken: 'pending'}))
    const reads = vi.spyOn(repo.prefs.get(a.workspaceId)!, 'get')
    stop = matrixIngestEffect.start({repo})
    await vi.waitFor(() => {
      expect(reads).toHaveBeenCalledWith(autoStartProp)
      expect(diagnostics.getSnapshot()?.summary).toBe('Matrix token is missing')
    })
    expect(createClient).not.toHaveBeenCalled()
    openSetup(repo)
    fireEvent.click(await screen.findByRole('button', {name: 'Bind saved device token'}))
    await vi.waitFor(() => expect(localStorage.getItem(tokenKey(a))).toBe('pending'))
    expect(localStorage.getItem(nextBatchKey(a))).toBeNull()
  })

  it('keeps the outstanding poll on an unrelated prefs edit', async () => {
    const repo = makeRepo()
    localStorage.setItem(tokenKey(a), 'bound-token')
    stop = matrixIngestEffect.start({repo})
    await vi.waitFor(() => expect(authedRequest).toHaveBeenCalledOnce())
    const signal = authedRequest.mock.calls[0][4].abortSignal as AbortSignal
    repo.prefs.get(a.workspaceId)!.set({name: 'unrelated'}, 'edit')
    expect(signal.aborted).toBe(false)
    expect(authedRequest).toHaveBeenCalledOnce()
  })

  it('forgets all device tokens while retaining cursors and unrelated settings', async () => {
    const repo = makeRepo()
    const blob = {baseUrl: a.baseUrl, roomId: a.roomId}
    localStorage.setItem(legacyConfigKey, JSON.stringify({...blob, accessToken: 'legacy'}))
    localStorage.setItem(legacyTokenKey, 'unscoped')
    localStorage.setItem(tokenKey(a), 'first')
    localStorage.setItem(tokenKey(otherWorkspace), 'second')
    localStorage.setItem(nextBatchKey(a), cursorState('position'))
    localStorage.setItem(legacyCursorKey, cursorState('old'))
    localStorage.setItem('unrelated', 'keep')
    openSetup(repo)
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    vi.stubGlobal('confirm', confirm)
    const button = await screen.findByRole('button', {name: /forget.*token/i})
    fireEvent.click(button)
    expect(localStorage.getItem(tokenKey(otherWorkspace))).toBe('second')
    fireEvent.click(button)
    expect(confirm).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(localStorage.getItem(tokenKey(otherWorkspace))).toBeNull())
    expect(localStorage.getItem(tokenKey(a))).toBeNull()
    expect(localStorage.getItem(legacyTokenKey)).toBeNull()
    expect(JSON.parse(localStorage.getItem(legacyConfigKey)!)).toEqual(blob)
    expect(localStorage.getItem(nextBatchKey(a))).toBe(cursorState('position'))
    expect(localStorage.getItem(legacyCursorKey)).toBe(cursorState('old'))
    expect(localStorage.getItem('unrelated')).toBe('keep')
  })

  it('starts and stops when another tab binds and disconnects this destination', async () => {
    const repo = makeRepo()
    const reads = vi.spyOn(repo.prefs.get(a.workspaceId)!, 'get')
    stop = matrixIngestEffect.start({repo})
    await vi.waitFor(() => expect(reads).toHaveBeenCalledWith(autoStartProp))
    const key = tokenKey(a)
    localStorage.setItem(key, 'another-tab')
    window.dispatchEvent(new StorageEvent('storage', {key}))
    expect(createClient).toHaveBeenCalledWith({baseUrl: a.baseUrl, accessToken: 'another-tab'})
    const signal = authedRequest.mock.calls[0][4].abortSignal as AbortSignal
    localStorage.removeItem(key)
    window.dispatchEvent(new StorageEvent('storage', {key}))
    expect(signal.aborted).toBe(true)
    expect(diagnostics.getSnapshot()?.summary).toBe('Matrix token is missing')
  })

  it('refuses a non-https homeserver', async () => {
    const repo = makeRepo()
    const insecure = {...a, baseUrl: 'http://matrix.test'}
    localStorage.setItem(tokenKey(insecure), 'fixture-token')
    repo.prefs.get(a.workspaceId)!.set(homeserverProp, insecure.baseUrl)
    stop = matrixIngestEffect.start({repo})
    await vi.waitFor(() => expect(diagnostics.getSnapshot()?.summary).toMatch(/configured|https/i))
    expect(createClient).not.toHaveBeenCalled()
  })

  it('abandons an outstanding poll across a switch away and back', async () => {
    const repo = makeRepo()
    localStorage.setItem(tokenKey(a), 'fixture-token')
    localStorage.setItem(nextBatchKey(a), cursorState('original'))
    localStorage.setItem(nextBatchKey(otherWorkspace), cursorState('other'))
    let deliver!: (body: unknown) => void
    const response = new Promise(resolve => { deliver = resolve })
    authedRequest.mockReturnValueOnce(response)
    stop = matrixIngestEffect.start({repo})
    await vi.waitFor(() => expect(authedRequest).toHaveBeenCalledOnce())
    const signal = authedRequest.mock.calls[0][4].abortSignal as AbortSignal
    expect(signal.aborted).toBe(false)
    repo.setActiveWorkspaceId(otherWorkspace.workspaceId)
    repo.setActiveWorkspaceId(a.workspaceId)
    deliver({next_batch: 'stale'})
    // The poll awaited this same SDK promise before we registered our continuation.
    await response
    expect(signal.aborted).toBe(true)
    expect(localStorage.getItem(nextBatchKey(a))).toBe(cursorState('original'))
    expect(localStorage.getItem(nextBatchKey(otherWorkspace))).toBe(cursorState('other'))
  })

  it.each(['message', 'empty'] as const)(
    'holds both cursors and stops on a workspace switch during the poll (%s batch)', async kind => {
      const repo = makeRepo()
      const controller = new AbortController()
      localStorage.setItem(nextBatchKey(a), cursorState('original'))
      localStorage.setItem(nextBatchKey(otherWorkspace), cursorState('other'))
      let deliver!: (body: unknown) => void
      authedRequest.mockImplementationOnce(() => new Promise(resolve => { deliver = resolve }))
      const run = pollLoop(repo, {...a, accessToken: 'fixture-token', autoStart: true},
        controller.signal, {http: {authedRequest}})
      expect(authedRequest.mock.calls[0][2].since).toBe('original')
      repo.activeWorkspaceId = otherWorkspace.workspaceId
      const events = kind === 'message' ? [{event_id: '$fixture', type: 'm.room.message'}] : []
      deliver({next_batch: 'advanced', rooms: {join: {[a.roomId]: {timeline: {events}}}}})
      try {
        await run
        expect(dailyNote).not.toHaveBeenCalled()
        expect(repo.tx).not.toHaveBeenCalled()
        expect(authedRequest).toHaveBeenCalledTimes(1)
        expect(localStorage.getItem(nextBatchKey(a))).toBe(cursorState('original'))
        expect(localStorage.getItem(nextBatchKey(otherWorkspace))).toBe(cursorState('other'))
      } finally {
        controller.abort()
      }
    },
  )
})

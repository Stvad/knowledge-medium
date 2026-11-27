// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createElement, type ComponentType} from 'react'
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react'
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
    db: {getAll: async () => []},
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

const confirmedDestination = `Destination: ${a.baseUrl} · ${a.roomId} · workspace ${a.workspaceId}`
let stop: (() => void) | undefined
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  authedRequest.mockImplementation(() => new Promise(() => {}))
})
afterEach(() => {
  cleanup()
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
      const blobPrefs = {baseUrl: legacyBaseUrl, roomId: a.roomId, customSetting: {flag: true}}
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
        expect(diagnostics.getSnapshot()?.summary).toBe('Matrix token is missing')
      })
      expect(JSON.parse(localStorage.getItem(legacyConfigKey)!)).toEqual({...blobPrefs, accessToken: embedded})
      expect(createClient).not.toHaveBeenCalled()
      expect(localStorage.getItem(nextBatchKey(a))).toBeNull()
      openSetup(repo)
      const bind = await screen.findByRole('button', {name: 'Bind saved device token'})
      expect(screen.getByText(confirmedDestination)).toBeTruthy()
      fireEvent.click(bind)
      await vi.waitFor(() => expect(authedRequest).toHaveBeenCalled())
      expect(createClient).toHaveBeenCalledWith({baseUrl: a.baseUrl, accessToken: 'pending-token'})
      expect(authedRequest.mock.calls[0][2].since).toBe('prior-position')
      expect(localStorage.getItem(legacyTokenKey)).toBeNull()
      expect(JSON.parse(localStorage.getItem(legacyConfigKey)!)).toEqual(
        source === 'legacy config' ? blobPrefs : {...blobPrefs, accessToken: embedded},
      )
      // A second device still derives its v1 cursor key from these synced prefs.
      expect(String(prefs.get(homeserverProp)).replace(/\/+$/, '')).toBe(legacyBaseUrl.slice(0, -1))
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
    expect(await screen.findByDisplayValue(legacyBaseUrl)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Access token'), {target: {value: 'new-token'}})
    expect(screen.getByText(confirmedDestination)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', {name: 'Save'}))
    await vi.waitFor(() => expect(localStorage.getItem(tokenKey(a))).toBe('new-token'))
    expect(localStorage.getItem(nextBatchKey(a))).toBe(cursorState('previous'))
    expect(localStorage.getItem(legacyCursorKey)).toBeNull()
    expect(localStorage.getItem(legacyTokenKey)).toBe('unselected-token')
  })

  it('preserves an existing scoped checkpoint when binding the saved token', async () => {
    const repo = makeRepo()
    repo.prefs.get(a.workspaceId)!.set(homeserverProp, legacyBaseUrl)
    localStorage.setItem(legacyTokenKey, 'pending-token')
    localStorage.setItem(legacyCursorKey, cursorState('previous'))
    localStorage.setItem(nextBatchKey(a), cursorState('current'))
    openSetup(repo)
    fireEvent.click(await screen.findByRole('button', {name: 'Bind saved device token'}))
    await vi.waitFor(() => expect(localStorage.getItem(tokenKey(a))).toBe('pending-token'))
    expect(localStorage.getItem(nextBatchKey(a))).toBe(cursorState('current'))
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

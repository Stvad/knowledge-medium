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
  getPluginPrefsBlock: (repo: ReturnType<typeof makeRepo>, workspaceId: string) => {
    const values = repo.prefs.get(workspaceId)!
    return {
      data: {workspaceId},
      get: (prop: {name: string}) => values.get(prop.name),
      set: (prop: {name: string}, value: unknown) => values.set(prop.name, value),
    }
  },
}))

import contributions, {
  autoStartProp, homeserverProp, matrixIngestEffect,
  nextBatchKey, pollLoop, roomIdProp, tokenKey,
} from './matrix-chat-client.tsx'

const a = {workspaceId: 'first', baseUrl: 'https://matrix.test', roomId: '!local:matrix.test'}
const otherWorkspace = {...a, workspaceId: 'second'}
const legacyBaseUrl = 'https://MATRIX.test:443/prefix/'
const legacyTokenKey = 'knowledge-medium:matrix:token:v1'
const legacyCursorKey = `knowledge-medium:matrix-messages:state:v1:${legacyBaseUrl.slice(0, -1)}:${a.roomId}`
const cursorState = (nextBatch: string) => JSON.stringify({nextBatch, savedAt: 1})
const diagnostics = contributions.find(c => c.facet.id === diagnosticsFacet.id)!.value as DiagnosticSourceContribution

function makeRepo() {
  const prefs = new Map([a, otherWorkspace].map(d => [d.workspaceId, new Map<string, unknown>([
    [homeserverProp.name, d.baseUrl], [roomIdProp.name, d.roomId], [autoStartProp.name, true],
  ])]))
  const listeners = new Set<() => void>()
  return {
    activeWorkspaceId: a.workspaceId, prefs, db: {getAll: async () => []}, tx: vi.fn(),
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
    stop()
    repo.activeWorkspaceId = changed.workspaceId
    const prefs = repo.prefs.get(changed.workspaceId)!
    prefs.set(homeserverProp.name, changed.baseUrl)
    prefs.set(roomIdProp.name, changed.roomId)
    stop = matrixIngestEffect.start({repo})
    await vi.waitFor(() => expect(diagnostics.getSnapshot()?.summary).toBe('Matrix token is missing'))
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(authedRequest).toHaveBeenCalledTimes(1)
  })

  it.each(['unscoped token', 'legacy config'] as const)(
    'keeps the %s pending until explicit bind and resumes its original cursor', async source => {
      const repo = makeRepo()
      const prefs = repo.prefs.get(a.workspaceId)!
      const reads = vi.spyOn(prefs, 'get')
      if (source === 'unscoped token') {
        prefs.set(homeserverProp.name, legacyBaseUrl)
        localStorage.setItem(legacyTokenKey, 'pending-token')
      } else {
        prefs.set(roomIdProp.name, '')
        localStorage.setItem('knowledge-medium:matrix-messages:config:v1', JSON.stringify({
          baseUrl: legacyBaseUrl, roomId: a.roomId, accessToken: 'pending-token',
        }))
      }
      localStorage.setItem(legacyCursorKey, cursorState('prior-position'))
      stop = matrixIngestEffect.start({repo})
      await vi.waitFor(() => {
        expect(reads).toHaveBeenCalledWith(autoStartProp.name)
        expect(localStorage.getItem(legacyTokenKey)).toBe('pending-token')
        expect(diagnostics.getSnapshot()?.summary).toBe('Matrix token is missing')
      })
      expect(createClient).not.toHaveBeenCalled()
      expect(localStorage.getItem(nextBatchKey(a))).toBeNull()
      const connect = contributions.find(c => (c.value as {id?: string}).id === 'matrix.connect')!.value as unknown as {handler: () => void}
      const mount = contributions.find(c => (c.value as {id?: string}).id === 'matrix.setup-dialog')!.value as {component: ComponentType}
      render(createElement(RepoContext.Provider, {value: repo as unknown as Repo}, createElement(mount.component)))
      act(() => connect.handler())
      const bind = await screen.findByRole('button', {name: /Bind saved device token/i})
      expect(bind.textContent).toContain(a.baseUrl)
      expect(bind.textContent).toContain(a.roomId)
      expect(bind.textContent).toContain(a.workspaceId)
      fireEvent.click(bind)
      await vi.waitFor(() => expect(authedRequest).toHaveBeenCalled())
      expect(createClient).toHaveBeenCalledWith({baseUrl: a.baseUrl, accessToken: 'pending-token'})
      expect(authedRequest.mock.calls[0][2].since).toBe('prior-position')
      expect(localStorage.getItem(legacyTokenKey)).toBeNull()
      expect(localStorage.getItem(nextBatchKey(otherWorkspace))).toBeNull()
      expect(localStorage.getItem(tokenKey(otherWorkspace))).toBeNull()
    },
  )

  it('refuses a non-https homeserver', async () => {
    const repo = makeRepo()
    const insecure = {...a, baseUrl: 'http://matrix.test'}
    localStorage.setItem(tokenKey(insecure), 'fixture-token')
    repo.prefs.get(a.workspaceId)!.set(homeserverProp.name, insecure.baseUrl)
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

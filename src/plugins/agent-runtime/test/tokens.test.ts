// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentTokenStore, type AgentToken } from '../tokens.ts'
import { ClientLocalSettings } from '@/utils/ClientLocalSettings.js'

class MemoryStorage {
  private map = new Map<string, string>()
  get length() { return this.map.size }
  key(index: number) { return [...this.map.keys()][index] ?? null }
  getItem(key: string) { return this.map.get(key) ?? null }
  setItem(key: string, value: string) { this.map.set(key, value) }
  removeItem(key: string) { this.map.delete(key) }
  clear() { this.map.clear() }
  keys() { return [...this.map.keys()] }
}

let storage: MemoryStorage
let store: AgentTokenStore

beforeEach(() => {
  storage = new MemoryStorage()
  store = new AgentTokenStore(new ClientLocalSettings(storage as unknown as Storage))
})

afterEach(() => {
  storage.clear()
})

/** A token as the per-(user, workspace) store wrote it before tokens were
 *  bound to the user. */
const seedLegacy = (userId: string, workspaceId: string, tokens: AgentToken[]) =>
  storage.setItem(`agent-runtime:tokens:${userId}:${workspaceId}`, JSON.stringify(tokens))

const legacyToken = (token: string, label = 'cli'): AgentToken =>
  ({token, label, scope: 'read-write', createdAt: 1, lastSeenAt: null})

describe('AgentTokenStore', () => {
  it('returns an empty list for an unknown user', () => {
    expect(store.list('alice')).toEqual([])
  })

  it('mints a token with a label and unique secret', () => {
    const a = store.create('alice', 'cli')
    const b = store.create('alice', 'scripts')

    expect(a.token).not.toEqual(b.token)
    expect(a.token.length).toBeGreaterThan(16)
    expect(store.list('alice').map(t => t.label)).toEqual(['cli', 'scripts'])
  })

  it('keeps each user\'s tokens apart', () => {
    store.create('alice', 'cli')
    store.create('bob', 'cli')

    expect(store.list('alice')).toHaveLength(1)
    expect(store.list('bob')).toHaveLength(1)
  })

  it('revokes by exact token value', () => {
    const a = store.create('alice', 'cli')
    const b = store.create('alice', 'scripts')

    store.revoke('alice', a.token)
    expect(store.list('alice').map(t => t.token)).toEqual([b.token])
  })

  it('falls back to a default label when blank', () => {
    const t = store.create('alice', '   ')
    expect(t.label).toBe('agent')
  })

  it('stores the requested token scope', () => {
    const readOnly = store.create('alice', 'reader', 'read-only')
    const readWrite = store.create('alice', 'writer')

    expect(readOnly.scope).toBe('read-only')
    expect(readWrite.scope).toBe('read-write')
  })

  it('rejects mint without a user', () => {
    expect(() => store.create('', 'x')).toThrow()
  })

  it('touch updates lastSeenAt', () => {
    const t = store.create('alice', 'cli')
    expect(t.lastSeenAt).toBeFalsy()
    store.touch('alice', t.token)
    const stored = store.list('alice')[0]
    expect(stored.lastSeenAt).toBeTypeOf('number')
  })
})

// Tokens used to be stored per (user, workspace) and registered only while
// their workspace was active. Every one of them is the user's, so each read
// folds those keys into the user's list — none is stranded under a workspace
// the tab no longer has open.
describe('AgentTokenStore — tokens minted per workspace', () => {
  it('lists the user\'s tokens from every workspace they were minted in', () => {
    seedLegacy('alice', 'ws-1', [legacyToken('T1')])
    seedLegacy('alice', 'ws-2', [legacyToken('T2')])
    const minted = store.create('alice', 'new')

    expect(store.list('alice').map(t => t.token).sort())
      .toEqual(['T1', 'T2', minted.token].sort())
  })

  it('removes the per-workspace keys once their tokens are in the user\'s list', () => {
    seedLegacy('alice', 'ws-1', [legacyToken('T1')])

    store.list('alice')

    expect(storage.keys()).toEqual(['agent-runtime:tokens:alice'])
  })

  it('leaves another user\'s per-workspace tokens alone', () => {
    seedLegacy('alice', 'ws-1', [legacyToken('T1')])
    seedLegacy('bob', 'ws-1', [legacyToken('B1')])

    expect(store.list('alice').map(t => t.token)).toEqual(['T1'])
    expect(storage.getItem('agent-runtime:tokens:bob:ws-1')).not.toBeNull()
  })

  it('keeps one entry for a token stored under both shapes', () => {
    seedLegacy('alice', 'ws-1', [legacyToken('T1', 'old-label')])
    storage.setItem('agent-runtime:tokens:alice', JSON.stringify([legacyToken('T1', 'current')]))

    expect(store.list('alice')).toEqual([expect.objectContaining({token: 'T1', label: 'current'})])
  })

  it('a revoke is not undone by a per-workspace copy of the same token', () => {
    seedLegacy('alice', 'ws-1', [legacyToken('T1')])

    store.revoke('alice', 'T1')

    expect(store.list('alice')).toEqual([])
  })
})

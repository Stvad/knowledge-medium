import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentTokenStore } from '../tokens.ts'
import { ClientLocalSettings } from '@/utils/ClientLocalSettings.ts'

// Production code only uses get/set/remove via ClientLocalSettings;
// the Storage interface's `key()` and `length` aren't exercised, so
// we don't bother shimming them. The cast in the consumer covers the
// type gap.
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string) { return this.map.get(key) ?? null }
  setItem(key: string, value: string) { this.map.set(key, value) }
  removeItem(key: string) { this.map.delete(key) }
  clear() { this.map.clear() }
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

describe('AgentTokenStore', () => {
  it('returns empty list for an unknown (user, workspace) pair', () => {
    expect(store.list('alice', 'ws-1')).toEqual([])
  })

  it('mints a token with a label and unique secret', () => {
    const a = store.create('alice', 'ws-1', 'cli')
    const b = store.create('alice', 'ws-1', 'scripts')

    expect(a.token).not.toEqual(b.token)
    expect(a.token.length).toBeGreaterThan(16)
    expect(store.list('alice', 'ws-1').map(t => t.label)).toEqual(['cli', 'scripts'])
  })

  it('scopes tokens by (userId, workspaceId)', () => {
    store.create('alice', 'ws-1', 'cli')
    store.create('bob', 'ws-1', 'cli')
    store.create('alice', 'ws-2', 'cli')

    expect(store.list('alice', 'ws-1')).toHaveLength(1)
    expect(store.list('bob', 'ws-1')).toHaveLength(1)
    expect(store.list('alice', 'ws-2')).toHaveLength(1)
  })

  it('revokes by exact token value', () => {
    const a = store.create('alice', 'ws-1', 'cli')
    const b = store.create('alice', 'ws-1', 'scripts')

    store.revoke('alice', 'ws-1', a.token)
    expect(store.list('alice', 'ws-1').map(t => t.token)).toEqual([b.token])
  })

  it('falls back to a default label when blank', () => {
    const t = store.create('alice', 'ws-1', '   ')
    expect(t.label).toBe('agent')
  })

  it('rejects mint without user/workspace', () => {
    expect(() => store.create('', 'ws-1', 'x')).toThrow()
    expect(() => store.create('alice', '', 'x')).toThrow()
  })

  it('touch updates lastSeenAt', () => {
    const t = store.create('alice', 'ws-1', 'cli')
    expect(t.lastSeenAt).toBeFalsy()
    store.touch('alice', 'ws-1', t.token)
    const stored = store.list('alice', 'ws-1')[0]
    expect(stored.lastSeenAt).toBeTypeOf('number')
  })
})

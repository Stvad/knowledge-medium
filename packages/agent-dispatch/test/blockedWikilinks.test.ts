import {describe, expect, it, vi} from 'vitest'
import type {BridgeGraph} from '@knowledge-medium/agent-cli/graph'
import {
  createBlockedWikilinkWriteGuard,
  decodeBlockedWikilinks,
  encodeBlockedWikilinks,
  findBlockedRef,
  findBlockedRefInProperties,
} from '../src/blockedWikilinks'

type GuardGraph = Pick<BridgeGraph, 'resolvePageId' | 'getBlock' | 'sqlAll'>

const graphFrom = (overrides: Partial<GuardGraph> = {}): GuardGraph => ({
  resolvePageId: async () => 'page-id-123',
  getBlock: async id => id === 'page-id-123'
    ? {id, content: 'claude', properties: {alias: ['cc']}}
    : null,
  sqlAll: async () => [],
  ...overrides,
})

describe('blocked wikilink helpers', () => {
  const guard = {aliases: ['claude', 'cc'], ids: ['page-id-123']}

  it('detects wikilinks by alias, case-insensitively', () => {
    expect(findBlockedRef('see [[claude]] now', guard)).toBe('[[claude]]')
    expect(findBlockedRef('see [[CC]] now', guard)).toBe('[[cc]]')
    expect(findBlockedRef('plain claude mention without link', guard)).toBeNull()
  })

  it('normalizes unicode before comparing aliases', () => {
    const composed = 'é'
    const decomposed = 'e\u0301'
    expect(findBlockedRef(`see [[${composed}]]`, {aliases: [decomposed], ids: []})).not.toBeNull()
    expect(findBlockedRef(`see [[${decomposed}]]`, {aliases: [composed], ids: []})).not.toBeNull()
  })

  it('detects block refs, embeds, and aliased block refs by id', () => {
    expect(findBlockedRef('ref ((page-id-123))', guard)).toBe('((page-id-123))')
    expect(findBlockedRef('embed !((page-id-123))', guard)).toBe('((page-id-123))')
    expect(findBlockedRef('aliased [label](((page-id-123)))', guard)).toBe('((page-id-123))')
    expect(findBlockedRef('other ((different-id))', guard)).toBeNull()
  })

  it('round-trips blocked wikilink env values without comma splitting JSON names', () => {
    const names = ['claude', 'browser, emacs']
    expect(decodeBlockedWikilinks(encodeBlockedWikilinks(names))).toEqual(names)
  })

  it('keeps legacy comma-separated parsing for hand-written configs', () => {
    expect(decodeBlockedWikilinks('claude, browser emacs')).toEqual(['claude', 'browser emacs'])
  })

  it('treats an absent blocked list as empty', () => {
    expect(decodeBlockedWikilinks(undefined)).toEqual([])
    expect(decodeBlockedWikilinks('')).toEqual([])
    expect(decodeBlockedWikilinks('[]')).toEqual([])
  })

  it('detects projected property refs and embedded content refs in properties', () => {
    expect(findBlockedRefInProperties({'some:ref': 'page-id-123'}, guard)).toBe('page-id-123')
    expect(findBlockedRefInProperties({'some:reflist': ['x', 'page-id-123']}, guard)).toBe('page-id-123')
    expect(findBlockedRefInProperties({note: 'see [[claude]]'}, guard)).toBe('[[claude]]')
    expect(findBlockedRefInProperties({title: 'unrelated', count: 3}, guard)).toBeNull()
    expect(findBlockedRefInProperties(undefined, guard)).toBeNull()
  })
})

describe('createBlockedWikilinkWriteGuard', () => {
  it('blocks create_block when content references a blocked target alias', async () => {
    const guard = createBlockedWikilinkWriteGuard(graphFrom(), ['claude'])

    await expect(guard.beforeWrite({
      type: 'create_block',
      parentId: 'parent',
      content: 'new mention of [[cc]]',
    })).rejects.toThrow('references a blocked page')
  })

  it('blocks move_block when the live moved block already references a blocked target', async () => {
    const guard = createBlockedWikilinkWriteGuard(graphFrom({
      getBlock: async id => {
        if (id === 'page-id-123') {
          return {id, content: 'claude', properties: {alias: ['cc']}}
        }
        return null
      },
      sqlAll: async (sql, params) => {
        if (sql.includes('SELECT content, properties_json')) {
          expect(params).toEqual(['source-block'])
          return [{content: 'old mention of [[claude]]', properties_json: '{}'}]
        }
        return []
      },
    }), ['claude'])

    await expect(guard.beforeWrite({
      type: 'move_block',
      id: 'source-block',
      parentId: 'new-parent',
      position: {kind: 'last'},
    })).rejects.toThrow('references a blocked page')
  })

  it('blocks move_block when a tombstoned moved block references a blocked target', async () => {
    const guard = createBlockedWikilinkWriteGuard(graphFrom({
      getBlock: async id => id === 'page-id-123'
        ? {id, content: 'claude', properties: {alias: ['cc']}}
        : null,
      sqlAll: async (sql, params) => {
        if (sql.includes('SELECT content, properties_json')) {
          expect(params).toEqual(['source-block'])
          return [{content: 'tombstoned mention of [[cc]]', properties_json: '{}'}]
        }
        return []
      },
    }), ['claude'])

    await expect(guard.beforeWrite({
      type: 'move_block',
      id: 'source-block',
      parentId: 'new-parent',
      position: {kind: 'last'},
    })).rejects.toThrow('references a blocked page')
  })

  it('blocks move_block when a live descendant references a blocked target', async () => {
    const guard = createBlockedWikilinkWriteGuard(graphFrom({
      getBlock: async id => id === 'page-id-123'
        ? {id, content: 'claude', properties: {alias: ['cc']}}
        : null,
      sqlAll: async (sql, params) => {
        if (sql.includes('SELECT content, properties_json')) {
          expect(params).toEqual(['source-block'])
          return [{content: 'safe parent', properties_json: '{}'}]
        }
        if (sql.includes('WHERE parent_id = ?')) {
          const parentId = params?.[0]
          if (parentId === 'source-block') {
            return [{id: 'child-block', content: 'child mentions [[cc]]', properties_json: '{}'}]
          }
          return []
        }
        return []
      },
    }), ['claude'])

    await expect(guard.beforeWrite({
      type: 'move_block',
      id: 'source-block',
      parentId: 'new-parent',
      position: {kind: 'last'},
    })).rejects.toThrow('references a blocked page')
  })

  it('blocks root move_block when a tombstoned move would re-key a tied blocked sibling', async () => {
    const sqlCalls: string[] = []
    const guard = createBlockedWikilinkWriteGuard(graphFrom({
      getBlock: async id => id === 'page-id-123'
        ? {id, content: 'claude', properties: {}}
        : null,
      sqlAll: vi.fn(async (sql, params) => {
        sqlCalls.push(sql)
        if (sql.includes('SELECT content, properties_json')) {
          expect(params).toEqual(['moving-tombstone'])
          return [{content: 'safe moving tombstone', properties_json: '{}'}]
        }
        if (sql.includes('WHERE parent_id = ?')) {
          return []
        }
        if (sql.includes('SELECT workspace_id')) {
          expect(params).toEqual(['moving-tombstone'])
          return [{workspace_id: 'ws-1'}]
        }
        return [
          {id: 'anchor', content: 'anchor', properties_json: '{}', order_key: 'a0'},
          {id: 'blocked-sibling', content: 'mentions [[claude]]', properties_json: '{}', order_key: 'a0'},
          {id: 'later', content: 'later', properties_json: '{}', order_key: 'a1'},
        ]
      }),
    }), ['claude'])

    await expect(guard.beforeWrite({
      type: 'move_block',
      id: 'moving-tombstone',
      parentId: null,
      position: {kind: 'after', siblingId: 'anchor'},
    })).rejects.toThrow('references a blocked page')

    const workspaceSql = sqlCalls.find(sql => sql.includes('SELECT workspace_id'))
    expect(workspaceSql).toContain('WHERE id = ? LIMIT 1')
    expect(workspaceSql).not.toContain('deleted = 0')
  })

  it('blocks delete_block when deep live subtree content could inline a blocked ref', async () => {
    const guard = createBlockedWikilinkWriteGuard(graphFrom({
      sqlAll: async (sql, params) => {
        if (sql.includes('WHERE id = ?')) {
          return [{id: 'source-block', content: 'safe root', properties_json: '{}'}]
        }
        if (sql.includes('WHERE parent_id = ?')) {
          const parentId = params?.[0]
          if (parentId === 'source-block') {
            return [{id: 'child-block', content: 'safe child', properties_json: '{}'}]
          }
          if (parentId === 'child-block') {
            return [{id: 'deep-block', content: 'deep mentions [[claude]]', properties_json: '{}'}]
          }
          return []
        }
        throw new Error(`Unexpected sql: ${sql}`)
      },
    }), ['claude'])

    await expect(guard.beforeWrite({
      type: 'delete_block',
      id: 'source-block',
    })).rejects.toThrow('references a blocked page')
  })

  it('reuses the resolved guard set within one write and refreshes it between writes', async () => {
    const resolvePageId = vi.fn(async () => 'page-id-123')
    const getBlock = vi.fn(async id => id === 'page-id-123'
      ? {id, content: 'claude', properties: {alias: ['cc']}}
      : null)
    const guard = createBlockedWikilinkWriteGuard(graphFrom({
      resolvePageId,
      getBlock,
      sqlAll: async (sql, params) => {
        if (sql.includes('SELECT content, properties_json')) {
          expect(params).toEqual(['source-block'])
          return [{content: 'safe root', properties_json: '{}'}]
        }
        if (sql.includes('WHERE parent_id = ?')) {
          const parentId = params?.[0]
          if (parentId === 'source-block') {
            return [
              {id: 'child-a', content: 'safe child a', properties_json: '{}'},
              {id: 'child-b', content: 'safe child b', properties_json: '{}'},
            ]
          }
          return []
        }
        throw new Error(`Unexpected sql: ${sql}`)
      },
    }), ['claude'])

    await guard.beforeWrite({type: 'delete_block', id: 'source-block'})

    expect(resolvePageId).toHaveBeenCalledTimes(1)
    expect(getBlock).toHaveBeenCalledTimes(1)

    await guard.beforeWrite({type: 'delete_block', id: 'source-block'})

    expect(resolvePageId).toHaveBeenCalledTimes(2)
    expect(getBlock).toHaveBeenCalledTimes(2)
  })

  it('does not cache an incomplete guard resolution within a write', async () => {
    const resolvePageId = vi.fn(async () => {
      if (resolvePageId.mock.calls.length === 1) throw new Error('transient bridge failure')
      return 'page-id-123'
    })
    const guard = createBlockedWikilinkWriteGuard(graphFrom({
      resolvePageId,
      getBlock: async id => id === 'page-id-123'
        ? {id, content: 'claude', properties: {alias: ['cc']}}
        : null,
      sqlAll: async (sql, params) => {
        if (sql.includes('SELECT content, properties_json')) {
          expect(params).toEqual(['source-block'])
          return [{content: 'safe root', properties_json: '{}'}]
        }
        if (sql.includes('WHERE parent_id = ?')) {
          const parentId = params?.[0]
          if (parentId === 'source-block') {
            return [{id: 'child-block', content: 'child mentions ((page-id-123))', properties_json: '{}'}]
          }
          return []
        }
        throw new Error(`Unexpected sql: ${sql}`)
      },
    }), ['claude'])

    await expect(guard.beforeWrite({
      type: 'delete_block',
      id: 'source-block',
    })).rejects.toThrow('references a blocked page')

    expect(resolvePageId).toHaveBeenCalledTimes(2)
  })

  it('blocks delete_block when a tombstoned root has a live descendant with a blocked ref', async () => {
    const guard = createBlockedWikilinkWriteGuard(graphFrom({
      sqlAll: async (sql, params) => {
        if (sql.includes('WHERE id = ? AND deleted = 0')) {
          return []
        }
        if (sql.includes('SELECT content, properties_json')) {
          expect(params).toEqual(['source-block'])
          return [{content: 'safe tombstoned root', properties_json: '{}'}]
        }
        if (sql.includes('WHERE parent_id = ?')) {
          const parentId = params?.[0]
          if (parentId === 'source-block') {
            return [{id: 'live-child', content: 'live child mentions [[claude]]', properties_json: '{}'}]
          }
          return []
        }
        throw new Error(`Unexpected sql: ${sql}`)
      },
    }), ['claude'])

    await expect(guard.beforeWrite({
      type: 'delete_block',
      id: 'source-block',
    })).rejects.toThrow('references a blocked page')
  })

  it('blocks restore_block when the tombstoned block references a blocked target', async () => {
    const guard = createBlockedWikilinkWriteGuard(graphFrom({
      sqlAll: async () => [{
        content: 'old mention of ((page-id-123))',
        properties_json: '{}',
      }],
    }), ['claude'])

    await expect(guard.beforeWrite({
      type: 'restore_block',
      id: 'source-block',
    })).rejects.toThrow('references a blocked page')
  })

  it('blocks restore_block when a live descendant would become reachable with a blocked ref', async () => {
    const guard = createBlockedWikilinkWriteGuard(graphFrom({
      sqlAll: async (sql, params) => {
        if (sql.includes('SELECT content, properties_json')) {
          expect(params).toEqual(['source-block'])
          return [{content: 'safe tombstoned root', properties_json: '{}'}]
        }
        if (sql.includes('WHERE parent_id = ?')) {
          const parentId = params?.[0]
          if (parentId === 'source-block') {
            return [{id: 'live-child', content: 'live child mentions ((page-id-123))', properties_json: '{}'}]
          }
          return []
        }
        throw new Error(`Unexpected sql: ${sql}`)
      },
    }), ['claude'])

    await expect(guard.beforeWrite({
      type: 'restore_block',
      id: 'source-block',
    })).rejects.toThrow('references a blocked page')
  })
})

describe('createBlockedWikilinkWriteGuard — markdown and edit writes', () => {
  it('blocks append_markdown when the markdown references a blocked target', async () => {
    const guard = createBlockedWikilinkWriteGuard(graphFrom(), ['claude'])
    await expect(guard.beforeWrite({
      type: 'append_markdown', target: 'today', markdown: '- ask [[claude]] about it',
    })).rejects.toThrow('references a blocked page')
  })

  it('blocks edit_block when the replacement text references a blocked target', async () => {
    const guard = createBlockedWikilinkWriteGuard(graphFrom(), ['claude'])
    await expect(guard.beforeWrite({
      type: 'edit_block', id: 'b', old: 'x', new: 'see [[claude]]',
    })).rejects.toThrow('references a blocked page')
  })

  it('blocks edit_block when the edit completes a blocked ref out of the stored content', async () => {
    const sqlAll = vi.fn<GuardGraph['sqlAll']>(async () => [{content: 'ping [[cla-ude]] later'}])
    const guard = createBlockedWikilinkWriteGuard(graphFrom({sqlAll}), ['claude'])
    await expect(guard.beforeWrite({type: 'edit_block', id: 'block-1', old: '-', new: ''}))
      .rejects.toThrow('references a blocked page')
    expect(sqlAll.mock.calls.at(-1)?.[1]).toEqual(['block-1'])
  })

  it('blocks a title that would carry a blocked wikilink when the write creates that page', async () => {
    // Only 'claude' (the blocked page) exists; every other name is missing.
    const guard = createBlockedWikilinkWriteGuard(graphFrom({
      resolvePageId: async name => {
        if (name === 'claude') return 'page-id-123'
        throw new Error(`Page "${name}" does not exist yet`)
      },
    }), ['claude'])
    await expect(guard.beforeWrite({type: 'create_page', name: 'notes [[claude]]'}))
      .rejects.toThrow('references a blocked page')
    await expect(guard.beforeWrite({type: 'create_page', name: '[[notes [[claude]]]]'}))
      .rejects.toThrow('references a blocked page')
    await expect(guard.beforeWrite({type: 'append_markdown', target: '[[notes [[claude]]]]', markdown: '- x'}))
      .rejects.toThrow('references a blocked page')
    await expect(guard.beforeWrite({type: 'create_block', parentId: '[[notes [[claude]]]]', content: 'x'}))
      .rejects.toThrow('references a blocked page')
    // Naming the blocked page itself creates no reference to it — wrapped or not,
    // since create-page strips one outer [[…]].
    await expect(guard.beforeWrite({type: 'create_page', name: 'claude'})).resolves.toBeUndefined()
    await expect(guard.beforeWrite({type: 'create_page', name: '[[claude]]'})).resolves.toBeUndefined()
    await expect(guard.beforeWrite({type: 'append_markdown', target: '[[claude]]', markdown: '- x'})).resolves.toBeUndefined()
  })

  it('lets a write into an EXISTING page through, whatever its title — nothing new is named', async () => {
    const guard = createBlockedWikilinkWriteGuard(graphFrom({resolvePageId: async () => 'page-id-123'}), ['claude'])
    await expect(guard.beforeWrite({type: 'create_block', parentId: '[[notes [[claude]]]]', content: 'x'}))
      .resolves.toBeUndefined()
    await expect(guard.beforeWrite({type: 'append_markdown', target: '[[notes [[claude]]]]', markdown: '- x'}))
      .resolves.toBeUndefined()
    await expect(guard.beforeWrite({type: 'create_page', name: 'notes [[claude]]'})).resolves.toBeUndefined()
  })
})

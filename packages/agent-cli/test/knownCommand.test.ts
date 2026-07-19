/**
 * Smoke tests for the discriminated union of known wire commands.
 * The schemas live in protocol.ts; both the CLI's construction sites
 * and (eventually) the kernel's dispatch switch type-check against
 * `KnownCommand`. These tests pin:
 *   - the variants we recognize
 *   - mandatory-field enforcement per variant
 *   - the parse error you get for a bad / unknown `type`
 */
import {describe, expect, it} from 'vitest'
import {knownCommandSchema, sqlModeSchema} from '../src/protocol'

describe('knownCommandSchema — branch acceptance', () => {
  // One representative valid body per variant. The point of the
  // exercise is "the schema knows about this command" — exhaustive
  // field coverage lives in the individual variant tests below.
  const cases: Array<[string, unknown]> = [
    ['ping', {type: 'ping'}],
    ['runtime-summary', {type: 'runtime-summary'}],
    ['describe-runtime', {type: 'describe-runtime', guides: ['external-sync-plugin'], brief: true}],
    ['sql', {type: 'sql', sql: 'SELECT 1', mode: 'all'}],
    ['sql (allowSyncedWrite)', {type: 'sql', sql: 'UPDATE blocks SET x = 1', mode: 'execute', allowSyncedWrite: true}],
    ['get-block', {type: 'get-block', id: 'b-1'}],
    ['get-subtree', {type: 'get-subtree', rootId: 'r-1'}],
    ['create-block', {type: 'create-block', parentId: 'p-1', content: 'hi'}],
    ['update-block', {type: 'update-block', id: 'b-1', content: 'hi'}],
    ['move-block', {type: 'move-block', id: 'b-1', parentId: 'p-1', position: {kind: 'last'}}],
    ['delete-block', {type: 'delete-block', id: 'b-1'}],
    ['restore-block', {type: 'restore-block', id: 'b-1'}],
    ['install-extension', {type: 'install-extension', source: '// source', label: 'foo'}],
    ['enable-extension', {type: 'enable-extension', label: 'foo'}],
    ['disable-extension', {type: 'disable-extension', label: 'foo'}],
    ['uninstall-extension', {type: 'uninstall-extension', label: 'foo'}],
    ['run-action', {type: 'run-action', id: 'action-id'}],
    ['eval', {type: 'eval', code: 'return 1'}],
    ['backlinks', {type: 'backlinks', id: 'b-1'}],
    ['backlinks (mode filter)', {type: 'backlinks', id: 'b-1', filter: 'effective'}],
    ['backlinks (object filter)', {type: 'backlinks', id: 'b-1', filter: {include: []}}],
    ['grouped-backlinks', {type: 'grouped-backlinks', id: 'b-1'}],
    ['grouped-backlinks (grouping)', {type: 'grouped-backlinks', id: 'b-1', grouping: 'none'}],
    ['data-model', {type: 'data-model'}],
    ['page', {type: 'page', name: 'Project Alpha'}],
    ['daily-note', {type: 'daily-note', date: 'yesterday'}],
    ['search', {type: 'search', query: 'recipe', limit: 10}],
  ]

  for (const [type, body] of cases) {
    it(`accepts a well-formed ${type} body`, () => {
      const result = knownCommandSchema.safeParse(body)
      expect(result.success, JSON.stringify(result)).toBe(true)
    })
  }
})

describe('knownCommandSchema — rejection', () => {
  it('rejects an unknown command type', () => {
    const result = knownCommandSchema.safeParse({type: 'not-a-real-command'})
    expect(result.success).toBe(false)
  })

  it('rejects a command with no `type`', () => {
    expect(knownCommandSchema.safeParse({}).success).toBe(false)
    expect(knownCommandSchema.safeParse({sql: 'SELECT 1'}).success).toBe(false)
  })

  it('rejects sql with no sql string', () => {
    expect(knownCommandSchema.safeParse({type: 'sql'}).success).toBe(false)
    expect(knownCommandSchema.safeParse({type: 'sql', sql: 42}).success).toBe(false)
  })

  it('rejects sql with an unknown mode', () => {
    expect(knownCommandSchema.safeParse({type: 'sql', sql: 'SELECT 1', mode: 'truncate'}).success).toBe(false)
  })

  it('rejects sql with a non-boolean allowSyncedWrite', () => {
    expect(
      knownCommandSchema.safeParse({type: 'sql', sql: 'SELECT 1', allowSyncedWrite: 'yes'}).success,
    ).toBe(false)
  })

  it('rejects install-extension without a source', () => {
    expect(knownCommandSchema.safeParse({type: 'install-extension'}).success).toBe(false)
    expect(knownCommandSchema.safeParse({type: 'install-extension', source: 123}).success).toBe(false)
  })

  it('rejects eval without code', () => {
    expect(knownCommandSchema.safeParse({type: 'eval'}).success).toBe(false)
  })

  it('accepts eval with a structured `data` payload', () => {
    const result = knownCommandSchema.safeParse({
      type: 'eval',
      code: 'return data.x',
      data: {x: 1, nested: ['a', 'b']},
    })
    expect(result.success).toBe(true)
    if (result.success) {
      const data = result.data as Record<string, unknown>
      expect(data.data).toEqual({x: 1, nested: ['a', 'b']})
    }
  })

  it('accepts eval with `data: null` (a legal JSON-serialized value)', () => {
    expect(knownCommandSchema.safeParse({
      type: 'eval',
      code: 'return data',
      data: null,
    }).success).toBe(true)
  })

  it('rejects run-action without id', () => {
    expect(knownCommandSchema.safeParse({type: 'run-action'}).success).toBe(false)
  })

  it('rejects get-subtree without rootId', () => {
    expect(knownCommandSchema.safeParse({type: 'get-subtree'}).success).toBe(false)
  })

  it('rejects move-block without a parentId or valid position', () => {
    expect(knownCommandSchema.safeParse({
      type: 'move-block',
      id: 'b-1',
      position: {kind: 'last'},
    }).success).toBe(false)
    expect(knownCommandSchema.safeParse({
      type: 'move-block',
      id: 'b-1',
      parentId: 'p-1',
      position: {kind: 'before'},
    }).success).toBe(false)
  })

  it('rejects delete-block / restore-block with a non-string id', () => {
    expect(knownCommandSchema.safeParse({type: 'delete-block', id: 42}).success).toBe(false)
    expect(knownCommandSchema.safeParse({type: 'restore-block', id: 42}).success).toBe(false)
  })

  it('rejects backlinks / grouped-backlinks with a non-string id', () => {
    expect(knownCommandSchema.safeParse({type: 'backlinks', id: 42}).success).toBe(false)
    expect(knownCommandSchema.safeParse({type: 'grouped-backlinks', id: 42}).success).toBe(false)
  })

  it('rejects page without name, daily-note without date, search without query', () => {
    expect(knownCommandSchema.safeParse({type: 'page'}).success).toBe(false)
    expect(knownCommandSchema.safeParse({type: 'daily-note'}).success).toBe(false)
    expect(knownCommandSchema.safeParse({type: 'search'}).success).toBe(false)
  })

  it('passes filter / grouping bodies through verbatim (kernel coerces them)', () => {
    const result = knownCommandSchema.safeParse({
      type: 'grouped-backlinks',
      id: 'b-1',
      filter: 'stored',
      grouping: {excludedTags: ['x']},
    })
    expect(result.success).toBe(true)
    if (result.success) {
      const data = result.data as Record<string, unknown>
      expect(data.filter).toBe('stored')
      expect(data.grouping).toEqual({excludedTags: ['x']})
    }
  })
})

describe('sqlModeSchema', () => {
  it('accepts the four valid modes', () => {
    for (const mode of ['all', 'get', 'optional', 'execute']) {
      expect(sqlModeSchema.safeParse(mode).success).toBe(true)
    }
  })

  it('rejects anything else', () => {
    expect(sqlModeSchema.safeParse('truncate').success).toBe(false)
    expect(sqlModeSchema.safeParse('').success).toBe(false)
    expect(sqlModeSchema.safeParse(undefined).success).toBe(false)
  })
})

describe('knownCommandSchema — passthrough', () => {
  it('preserves extra keys on create-block (kernel reads `position`, `properties` directly)', () => {
    const result = knownCommandSchema.safeParse({
      type: 'create-block',
      parentId: 'p-1',
      position: 'last',
      content: 'hi',
      properties: {note: 'x'},
    })
    expect(result.success).toBe(true)
    if (result.success) {
      // looseObject preserves unknown keys at runtime.
      const data = result.data as Record<string, unknown>
      expect(data.position).toBe('last')
      expect(data.properties).toEqual({note: 'x'})
    }
  })

  it('attaches an optional `commandId` (set by the bridge before forwarding)', () => {
    const result = knownCommandSchema.safeParse({
      type: 'ping',
      commandId: 'abc-123',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.commandId).toBe('abc-123')
    }
  })
})

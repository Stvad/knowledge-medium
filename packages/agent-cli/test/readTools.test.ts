import {describe, expect, it} from 'vitest'
import {
  cliCommandFrom,
  cliInputFrom,
  cliOptionsFor,
  GRAPH_READ_TOOLS,
  hasJsonFormat,
  renderToolResult,
  toolCommand,
  type GraphReadTool,
} from '../src/readTools'

const tool = (name: string): GraphReadTool => {
  const found = GRAPH_READ_TOOLS.find(t => t.name === name)
  if (!found) throw new Error(`no tool ${name}`)
  return found
}

describe('cliOptionsFor', () => {
  it('derives flags from the wire schema, minus the positional and format', () => {
    const options = cliOptionsFor(tool('subtree'))
    const byKey = Object.fromEntries(options.map(o => [o.key, o]))
    expect(Object.keys(byKey).sort()).toEqual(
      ['depth', 'expand-collapsed', 'limit', 'offset', 'properties', 'workspace'],
    )
    expect(byKey['expand-collapsed'].flag).toBe('--expand-collapsed')
    expect(byKey.depth.flag).toBe('--depth <value>')
    expect(byKey.workspace.flag).toBe('--workspace <id>')
    expect(byKey.depth.description).toMatch(/Levels below the root/)
  })

  it('exposes the filter union as a keyword-or-JSON spec', () => {
    const filter = cliOptionsFor(tool('backlinks')).find(o => o.field === 'filter')
    expect(filter).toMatchObject({kind: 'spec', keywords: ['none', 'stored', 'effective']})
  })

  it('offers --json only where the wire command has a format', () => {
    expect(hasJsonFormat(tool('search'))).toBe(true)
    expect(hasJsonFormat(tool('page'))).toBe(false)
  })
})

describe('cliInputFrom', () => {
  it('coerces numbers and rejects non-integers naming the flag', () => {
    expect(cliInputFrom(tool('search'), ['hello'], {limit: '5'})).toEqual({query: 'hello', limit: 5})
    expect(() => cliInputFrom(tool('search'), ['hello'], {limit: '2.5'})).toThrow(/--limit expects an integer/)
  })

  it('reports the empty-value 0 CAC produces for a number flag', () => {
    expect(() => cliInputFrom(tool('search'), ['hello'], {limit: 0}))
      .toThrow(/--limit:.*empty value/)
  })

  it('maps workspace and rejects a repeated string flag', () => {
    expect(cliInputFrom(tool('get_block'), '^3f2a', {workspace: 'ws-1'}))
      .toEqual({ref: '^3f2a', workspaceId: 'ws-1'})
    expect(() => cliInputFrom(tool('search'), ['x'], {under: ['a', 'b']}))
      .toThrow(/--under expects a single value/)
    expect(() => cliInputFrom(tool('get_block'), 'x', {workspace: ['a', 'b']}))
      .toThrow(/--workspace/)
  })

  it('refuses a string flag cac already turned into a number, rather than lose its leading zeros', () => {
    // `--under 00123456` reaches the action as the number 123456.
    expect(() => cliInputFrom(tool('search'), ['x'], {under: 123456}))
      .toThrow(/--under got the number 123456.*\^123456/)
  })

  it('accepts a single or repeated string-array flag, splitting commas', () => {
    expect(cliInputFrom(tool('search'), ['x'], {types: 'todo,page'}).types).toEqual(['todo', 'page'])
    expect(cliInputFrom(tool('search'), ['x'], {types: ['todo', 'page,note']}).types)
      .toEqual(['todo', 'page', 'note'])
  })

  it('passes filter keywords through and parses anything else as JSON', () => {
    expect(cliInputFrom(tool('backlinks'), 'p', {filter: 'stored'}).filter).toBe('stored')
    expect(cliInputFrom(tool('backlinks'), 'p', {filter: '{"include":["a"]}'}).filter)
      .toEqual({include: ['a']})
    expect(() => cliInputFrom(tool('backlinks'), 'p', {filter: '{oops'}))
      .toThrow(/--filter must be one of none\|stored\|effective or valid JSON/)
  })

  it('names the flag when the schema rejects a value', () => {
    expect(() => cliInputFrom(tool('subtree'), 'p', {properties: 'weird'})).toThrow(/--properties/)
  })

  it('joins variadic positionals and refuses an empty one', () => {
    expect(cliInputFrom(tool('search'), ['two', 'words'], {})).toEqual({query: 'two words'})
    expect(() => cliInputFrom(tool('search'), [], {})).toThrow(/search requires a <query>/)
  })

  it('sets format from --json', () => {
    expect(cliInputFrom(tool('get_block'), 'x', {json: true})).toEqual({ref: 'x', format: 'json'})
  })
})

describe('cliCommandFrom', () => {
  it('sends the view command by default', () => {
    expect(cliCommandFrom(tool('subtree'), 'today', {depth: 2}))
      .toEqual({type: 'view-outline', ref: 'today', depth: 2})
  })

  it('maps --raw onto the stored command shapes', () => {
    expect(cliCommandFrom(tool('get_block'), 'b1', {raw: true})).toEqual({type: 'get-block', id: 'b1'})
    expect(cliCommandFrom(tool('subtree'), 'b1', {raw: true})).toEqual({type: 'get-subtree', rootId: 'b1'})
    expect(cliCommandFrom(tool('backlinks'), 'b1', {raw: true, filter: 'stored', workspace: 'w'}))
      .toEqual({type: 'backlinks', id: 'b1', filter: 'stored', workspaceId: 'w'})
    expect(cliCommandFrom(tool('search'), ['q'], {raw: true, limit: 3}))
      .toEqual({type: 'search', query: 'q', limit: 3})
  })

  it('refuses view-only flags under --raw instead of dropping them', () => {
    expect(() => cliCommandFrom(tool('subtree'), 'b1', {raw: true, depth: 2}))
      .toThrow(/--depth cannot be combined with --raw/)
    expect(() => cliCommandFrom(tool('get_block'), 'b1', {raw: true, json: true}))
      .toThrow(/--json cannot be combined with --raw/)
  })
})

describe('toolCommand', () => {
  it('prefixes the wire type', () => {
    expect(toolCommand(tool('daily_note'), {date: 'today'})).toEqual({type: 'daily-note', date: 'today'})
  })

  it('sql_query applies the maxRows default and refuses writes', () => {
    const sql = tool('sql_query')
    expect(toolCommand(sql, {sql: 'select 1'}))
      .toEqual({type: 'sql', mode: 'all', sql: 'select 1', params: [], maxRows: 200})
    expect(toolCommand(sql, {sql: 'select 1', maxRows: 5, params: [1]}))
      .toMatchObject({maxRows: 5, params: [1]})
    expect(() => toolCommand(sql, {sql: 'delete from blocks'})).toThrow(/read-only/)
  })
})

describe('renderToolResult', () => {
  it('passes strings through and pretty-prints the rest', () => {
    expect(renderToolResult('- a  ^1')).toBe('- a  ^1')
    expect(renderToolResult({a: 1})).toBe('{\n  "a": 1\n}')
  })
})

import {describe, expect, it} from 'vitest'
import {
  decodeBlockedWikilinks,
  encodeBlockedWikilinks,
  findBlockedRef,
  findBlockedRefInProperties,
  isReadOnlySql,
} from '../src/mcpShared'

describe('isReadOnlySql', () => {
  it.each([
    'SELECT * FROM blocks',
    '  select id from blocks where content like ?',
    'WITH RECURSIVE anc(id) AS (SELECT parent_id FROM blocks WHERE id = ?) SELECT * FROM anc',
    'EXPLAIN SELECT 1',
    'SELECT 1;',
  ])('accepts read statement: %s', sql => {
    expect(isReadOnlySql(sql)).toBe(true)
  })

  it.each([
    'UPDATE blocks SET content = ?',
    'DELETE FROM blocks',
    'INSERT INTO blocks VALUES (1)',
    // The CTE bypass the naive prologue regex allowed:
    'WITH x AS (SELECT 1) UPDATE blocks SET content = ?',
    'with doomed as (select id from blocks) delete from blocks where id in (select id from doomed)',
    // Multi-statement smuggling:
    'SELECT 1; UPDATE blocks SET content = ?',
    'PRAGMA journal_mode = DELETE',
    'DROP TABLE blocks',
    // Side-effecting PowerSync functions invoked from a SELECT prologue —
    // the "SELECT ⇒ read-only" premise is false on this connection.
    'SELECT powersync_clear(1)',
    'select powersync_replace_schema(?)',
    'SELECT powersync_control(?, ?)',
    'WITH x AS (SELECT 1) SELECT powersync_clear(1)',
    'SELECT b.id FROM blocks b WHERE powersync_clear(1)',
    // Comment between the fn name and its ( — SQLite treats the comment
    // as whitespace, so these are valid calls that a `\\s*\\(` guard missed.
    'SELECT powersync_clear/**/(1)',
    'SELECT powersync_clear /**/ (1)',
    'SELECT powersync_clear-- x\n(1)',
  ])('rejects mutating statement: %s', sql => {
    expect(isReadOnlySql(sql)).toBe(false)
  })
})

describe('findBlockedRef', () => {
  const guard = {aliases: ['claude', 'cc'], ids: ['page-id-123']}

  it('blocks any alias of the target page, case-insensitively', () => {
    expect(findBlockedRef('see [[claude]] now', guard)).toBe('[[claude]]')
    expect(findBlockedRef('see [[CC]] now', guard)).toBe('[[cc]]')
    expect(findBlockedRef('plain claude mention without link', guard)).toBeNull()
  })

  it('blocks aliases in either Unicode normalization form (app resolves them as equal)', () => {
    const composed = 'café'        // é as one code point
    const decomposed = 'café'     // e + combining accent
    expect(findBlockedRef(`see [[${composed}]]`, {aliases: [decomposed], ids: []})).not.toBeNull()
    expect(findBlockedRef(`see [[${decomposed}]]`, {aliases: [composed], ids: []})).not.toBeNull()
  })

  it('blocks block-refs to the target id in every syntax form', () => {
    expect(findBlockedRef('ref ((page-id-123))', guard)).toBe('((page-id-123))')
    expect(findBlockedRef('embed !((page-id-123))', guard)).toBe('((page-id-123))')
    expect(findBlockedRef('aliased [label](((page-id-123)))', guard)).toBe('((page-id-123))')
    expect(findBlockedRef('other ((different-id))', guard)).toBeNull()
  })
})

describe('blocked-wikilinks env encoding', () => {
  it('round-trips names containing commas and padding (comma-join would corrupt them)', () => {
    const names = ['claude', 'to review, later', ' spaced ']
    expect(decodeBlockedWikilinks(encodeBlockedWikilinks(names))).toEqual(names)
  })

  it('still decodes the legacy comma-separated form', () => {
    expect(decodeBlockedWikilinks('claude, browser emacs')).toEqual(['claude', 'browser emacs'])
  })

  it('handles empty and undefined values', () => {
    expect(decodeBlockedWikilinks(undefined)).toEqual([])
    expect(decodeBlockedWikilinks('')).toEqual([])
    expect(decodeBlockedWikilinks('[]')).toEqual([])
  })
})

describe('findBlockedRefInProperties', () => {
  const guard = {aliases: ['claude'], ids: ['page-id-123']}

  it('catches a ref-typed property whose bare value is the target id', () => {
    // A ref codec stores the raw id; projecting it creates a backlink
    // with no [[...]] in content — the content guard would miss it.
    expect(findBlockedRefInProperties({'some:ref': 'page-id-123'}, guard)).toBe('page-id-123')
    expect(findBlockedRefInProperties({'some:reflist': ['x', 'page-id-123']}, guard)).toBe('page-id-123')
  })

  it('catches a wikilink smuggled through a property value', () => {
    expect(findBlockedRefInProperties({note: 'see [[claude]]'}, guard)).toBe('[[claude]]')
  })

  it('passes clean property maps and undefined', () => {
    expect(findBlockedRefInProperties({title: 'unrelated', count: 3}, guard)).toBeNull()
    expect(findBlockedRefInProperties(undefined, guard)).toBeNull()
  })
})

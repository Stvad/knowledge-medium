import {describe, expect, it} from 'vitest'
import {findBlockedRef, isReadOnlySql} from '../src/mcpShared'

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

  it('blocks block-refs to the target id in every syntax form', () => {
    expect(findBlockedRef('ref ((page-id-123))', guard)).toBe('((page-id-123))')
    expect(findBlockedRef('embed !((page-id-123))', guard)).toBe('((page-id-123))')
    expect(findBlockedRef('aliased [label](((page-id-123)))', guard)).toBe('((page-id-123))')
    expect(findBlockedRef('other ((different-id))', guard)).toBeNull()
  })
})

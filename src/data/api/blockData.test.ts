import { describe, expect, it } from 'vitest'
import { normalizeReferences } from './blockData'

describe('normalizeReferences', () => {
  it('returns [] unchanged', () => {
    expect(normalizeReferences([])).toEqual([])
  })

  it('sorts by (sourceField, id, alias)', () => {
    const input = [
      {id: 'b', alias: 'b', sourceField: 'reviewer'},
      {id: 'a', alias: 'a', sourceField: 'related'},
      {id: 'b', alias: 'b', sourceField: 'related'},
    ]
    expect(normalizeReferences(input)).toEqual([
      {id: 'a', alias: 'a', sourceField: 'related'},
      {id: 'b', alias: 'b', sourceField: 'related'},
      {id: 'b', alias: 'b', sourceField: 'reviewer'},
    ])
  })

  it('treats absent sourceField as the empty string and groups content refs first', () => {
    const input = [
      {id: 'x', alias: 'x', sourceField: 'reviewer'},
      {id: 'c', alias: 'content-alias'},
    ]
    expect(normalizeReferences(input)).toEqual([
      {id: 'c', alias: 'content-alias'},
      {id: 'x', alias: 'x', sourceField: 'reviewer'},
    ])
  })

  it('omits sourceField from output when input had it absent (does not add `sourceField: ""`)', () => {
    const [out] = normalizeReferences([{id: 'a', alias: 'a'}])
    expect(out).toEqual({id: 'a', alias: 'a'})
    expect('sourceField' in out).toBe(false)
  })

  it('collapses exact duplicates', () => {
    const input = [
      {id: 'a', alias: 'a'},
      {id: 'a', alias: 'a'},
      {id: 'a', alias: 'a', sourceField: 'r'},
      {id: 'a', alias: 'a', sourceField: 'r'},
    ]
    expect(normalizeReferences(input)).toEqual([
      {id: 'a', alias: 'a'},
      {id: 'a', alias: 'a', sourceField: 'r'},
    ])
  })

  it('keeps entries that differ only in alias', () => {
    // Same target id surfaced under two distinct alias texts is legitimate
    // (e.g. `[[Foo]]` and `[[foo bar]]` both resolving to the same block
    // via separate aliases) — dedupe key includes alias.
    const input = [
      {id: 'a', alias: 'Foo'},
      {id: 'a', alias: 'foo bar'},
    ]
    expect(normalizeReferences(input)).toEqual([
      {id: 'a', alias: 'Foo'},
      {id: 'a', alias: 'foo bar'},
    ])
  })

  it('is idempotent', () => {
    const input = [
      {id: 'b', alias: 'b', sourceField: 'reviewer'},
      {id: 'a', alias: 'a', sourceField: 'related'},
    ]
    const once = normalizeReferences(input)
    const twice = normalizeReferences(once)
    expect(twice).toEqual(once)
  })
})

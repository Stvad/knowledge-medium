// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ChangeScope, codecs, defineProperty } from '@/data/api'
import { scalarValueRow } from './propertyChildren'

const schema = defineProperty('scalar-target', {
  codec: codecs.number, defaultValue: 0, changeScope: ChangeScope.BlockDefault,
})

const peer = {content: '9'}
const current = {content: '5'}

describe('scalarValueRow', () => {
  it('prefers the replaced content over an earlier decodable peer', () => {
    expect(scalarValueRow(schema, [peer, current], '7', 5)).toBe(current)
  })

  it('prefers the replaced row even when a peer already holds the new content', () => {
    expect(scalarValueRow(schema, [peer, current], '9', 5)).toBe(current)
  })

  it('does not prefer blank content when the cell is absent', () => {
    expect(scalarValueRow(schema, [{content: ''}, peer], '7')).toBe(peer)
  })

  it('falls back when a legacy cell cannot be rendered as content', () => {
    const ref = defineProperty('scalar-ref', {
      codec: codecs.ref(), defaultValue: '', changeScope: ChangeScope.BlockDefault,
    })
    const row = {content: '((target))'}
    expect(scalarValueRow(ref, [row], '((new-target))', 'bad reference')).toBe(row)
  })

  it('keeps the existing fallback when no row matches the replaced content', () => {
    expect(scalarValueRow(schema, [peer, current], '7', 3)).toBe(peer)
    const broken = {content: 'notes'}
    expect(scalarValueRow(schema, [broken], '7', 3)).toBe(broken)
    expect(scalarValueRow(schema, [broken, {content: 'more notes'}], '7', 3)).toBeUndefined()
  })
})

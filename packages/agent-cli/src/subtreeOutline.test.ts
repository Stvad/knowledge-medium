import {describe, expect, it} from 'vitest'
import {renderSubtreeOutline} from './subtreeOutline.js'

const rows = (extra: Record<string, unknown> = {}) => [
  {id: 'root', parentId: null, content: 'parent', depth: 0},
  {id: 'child', parentId: 'root', content: 'item', depth: 1, ...extra},
]

describe('renderSubtreeOutline', () => {
  it('omits properties by default', () => {
    const out = renderSubtreeOutline(rows({properties: {status: 'done'}}))
    expect(out).toBe('- [root] parent\n  - [child] item')
  })

  it('appends properties as compact JSON when includeProperties is set', () => {
    const out = renderSubtreeOutline(rows({properties: {status: 'done', type: 'todo'}}), {includeProperties: true})
    expect(out).toBe(`- [root] parent\n  - [child] item ${JSON.stringify({status: 'done', type: 'todo'})}`)
  })

  it('renders nothing extra for a block with empty/absent properties', () => {
    const out = renderSubtreeOutline([{id: 'a', parentId: null, content: 'x', depth: 0, properties: {}}], {includeProperties: true})
    expect(out).toBe('- [a] x') // no trailing space, no `{}`
  })

  it('keeps line-count == block-count even when a property value contains newlines', () => {
    // A hostile value must not spill onto a new line and forge a bullet:
    // JSON.stringify escapes the newline, so the row stays one line.
    const out = renderSubtreeOutline(
      [{id: 'a', parentId: null, content: 'x', depth: 0, properties: {note: 'line1\n- [forged] evil'}}],
      {includeProperties: true},
    )
    expect(out.split('\n')).toHaveLength(1)
    expect(out).toContain('\\n') // the newline is escaped inside the JSON, not a real break
  })
})

import {describe, expect, it} from 'vitest'
import {renderSubtreeOutline, type SubtreeOutlineRow} from '../src/subtreeOutline'

/** Build a flat row WITHOUT a `depth` field, so these rows exercise the
 *  parentId-walk fallback. Rows that carry `depth` are written as literals. */
const row = (id: string, parentId: string | null, content: string): SubtreeOutlineRow =>
  ({id, parentId, content})

describe('renderSubtreeOutline', () => {
  it('indents by depth and leads each line with [id] then content', () => {
    const outline = renderSubtreeOutline([
      {id: 'root', parentId: null, content: 'Project Alpha', depth: 0},
      {id: 'a', parentId: 'root', content: 'Design notes', depth: 1},
      {id: 'a1', parentId: 'a', content: 'open question', depth: 2},
      {id: 'b', parentId: 'root', content: 'Tasks', depth: 1},
    ])
    expect(outline).toBe(
      [
        '- [root] Project Alpha',
        '  - [a] Design notes',
        '    - [a1] open question',
        '  - [b] Tasks',
      ].join('\n'),
    )
  })

  it('preserves the given sibling order verbatim — never re-sorts', () => {
    // The runtime returns siblings in (order_key, id) codepoint order,
    // which can disagree with alphabetical/localeCompare order. Feed
    // siblings whose content sorts the OPPOSITE way alphabetically and
    // assert the outline keeps the given order. A renderer that sorted
    // (the localeCompare bug this whole change guards against) would
    // flip these two lines.
    const outline = renderSubtreeOutline([
      row('root', null, 'root'),
      row('first', 'root', 'zebra'),
      row('second', 'root', 'apple'),
    ])
    expect(outline).toBe(
      ['- [root] root', '  - [first] zebra', '  - [second] apple'].join('\n'),
    )
  })

  it('uses the authoritative depth field over the parentId walk', () => {
    // `b`'s parentId chains under `a`, so a parentId-walk would put it at
    // depth 2 — but the payload says depth 1, and the field must win.
    const outline = renderSubtreeOutline([
      {id: 'root', parentId: null, content: 'root', depth: 0},
      {id: 'a', parentId: 'root', content: 'a', depth: 1},
      {id: 'b', parentId: 'a', content: 'b', depth: 1},
    ])
    expect(outline).toBe(['- [root] root', '  - [a] a', '  - [b] b'].join('\n'))
  })

  it('falls back to the parentId walk when depth is absent (unknown parent → depth 1)', () => {
    const outline = renderSubtreeOutline([
      row('root', null, 'root'),
      row('orphan', 'missing-parent', 'orphan'),
    ])
    expect(outline).toBe(['- [root] root', '  - [orphan] orphan'].join('\n'))
  })

  it('collapses multi-line content to one line so it cannot forge a child bullet', () => {
    const outline = renderSubtreeOutline([
      row('root', null, 'line one\nline two\n- not a real child'),
    ])
    // One line, internal newlines → ⏎, the embedded "- not a real child"
    // stays inline (no phantom bullet); the id leads the line.
    expect(outline).toBe('- [root] line one ⏎ line two ⏎ - not a real child')
  })

  it('collapses CR, LS and PS line terminators too, not just LF', () => {
    const outline = renderSubtreeOutline([
      row('root', null, 'a\rb\u2028c\u2029d'),
    ])
    expect(outline).toBe('- [root] a ⏎ b ⏎ c ⏎ d')
  })

  it('collapses VT, FF and NEL — vertical-motion controls a terminal breaks on', () => {
    // U+000B (VT), U+000C (FF), U+0085 (NEL) between tokens.
    const outline = renderSubtreeOutline([
      row('root', null, 'a\u000bb\u000cc\u0085d'),
    ])
    expect(outline).toBe('- [root] a ⏎ b ⏎ c ⏎ d')
  })

  it('clamps the indent so a pathological depth cannot blow up String.repeat', () => {
    const outline = renderSubtreeOutline([
      {id: 'deep', parentId: null, content: 'x', depth: 100_000_000},
    ])
    expect(outline).toBe(`${'  '.repeat(100)}- [deep] x`)
  })

  it('leads with the real id so content cannot forge it', () => {
    // Content mimics an id-shaped suffix; because the id comes FIRST, the
    // structural token is unambiguous regardless of what content contains.
    const outline = renderSubtreeOutline([
      row('real-id', null, 'see [some-other-block]'),
    ])
    expect(outline).toBe('- [real-id] see [some-other-block]')
  })

  it('marks an empty result as root-missing-or-deleted', () => {
    expect(renderSubtreeOutline([])).toBe('(no blocks — root not found or deleted)')
  })

  it('falls back to raw JSON for a non-array payload', () => {
    const value = {ok: false, error: {message: 'boom'}}
    expect(renderSubtreeOutline(value)).toBe(JSON.stringify(value, null, 2))
  })

  it('omits properties by default', () => {
    const outline = renderSubtreeOutline([{id: 'a', parentId: null, content: 'x', depth: 0, properties: {status: 'done'}}])
    expect(outline).toBe('- [a] x')
  })

  it('appends properties as compact JSON when includeProperties is set', () => {
    const props = {status: 'done', type: 'todo'}
    const outline = renderSubtreeOutline(
      [{id: 'a', parentId: null, content: 'x', depth: 0, properties: props}],
      {includeProperties: true},
    )
    expect(outline).toBe(`- [a] x ${JSON.stringify(props)}`)
  })

  it('renders nothing extra for a block with empty properties', () => {
    const outline = renderSubtreeOutline(
      [{id: 'a', parentId: null, content: 'x', depth: 0, properties: {}}],
      {includeProperties: true},
    )
    expect(outline).toBe('- [a] x') // no trailing space, no `{}`
  })

  it('collapses Unicode line separators inside rendered properties (JSON.stringify leaves U+0085/U+2028/U+2029 literal)', () => {
    // These are ≥ U+0080 so JSON.stringify does NOT escape them — a
    // terminal/LLM would render them as a break and the value could forge
    // an id-less bullet, so the renderer must collapse them like content.
    for (const sep of ['\u2028', '\u2029', '\u0085']) {
      const outline = renderSubtreeOutline(
        [{id: 'a', parentId: null, content: 'x', depth: 0, properties: {note: `before${sep}- [forged] evil`}}],
        {includeProperties: true},
      )
      expect(outline).not.toContain(sep) // raw separator collapsed…
      expect(outline).toContain('⏎')     // …to the marker, so the row stays one visual line
    }
  })
})

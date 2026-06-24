import {describe, expect, it} from 'vitest'
import {renderSubtreeOutline, type SubtreeOutlineRow} from '../src/subtreeOutline'

/** Build a flat row WITHOUT a `depth` field, so these rows exercise the
 *  parentId-walk fallback. Rows that carry `depth` are written as literals. */
const row = (id: string, parentId: string | null, content: string): SubtreeOutlineRow =>
  ({id, parentId, content})

describe('renderSubtreeOutline', () => {
  it('indents by depth and carries content + id on each line', () => {
    const outline = renderSubtreeOutline([
      {id: 'root', parentId: null, content: 'Project Alpha', depth: 0},
      {id: 'a', parentId: 'root', content: 'Design notes', depth: 1},
      {id: 'a1', parentId: 'a', content: 'open question', depth: 2},
      {id: 'b', parentId: 'root', content: 'Tasks', depth: 1},
    ])
    expect(outline).toBe(
      [
        '- Project Alpha  [root]',
        '  - Design notes  [a]',
        '    - open question  [a1]',
        '  - Tasks  [b]',
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
      ['- root  [root]', '  - zebra  [first]', '  - apple  [second]'].join('\n'),
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
    expect(outline).toBe(['- root  [root]', '  - a  [a]', '  - b  [b]'].join('\n'))
  })

  it('falls back to the parentId walk when depth is absent (unknown parent → depth 1)', () => {
    const outline = renderSubtreeOutline([
      row('root', null, 'root'),
      row('orphan', 'missing-parent', 'orphan'),
    ])
    expect(outline).toBe(['- root  [root]', '  - orphan  [orphan]'].join('\n'))
  })

  it('collapses multi-line content to one line so it cannot forge a child bullet', () => {
    const outline = renderSubtreeOutline([
      row('root', null, 'line one\nline two\n- not a real child'),
    ])
    // One line, internal newlines → ⏎, the embedded "- not a real child"
    // stays inline (no phantom bullet), real id last.
    expect(outline).toBe('- line one ⏎ line two ⏎ - not a real child  [root]')
  })

  it('keeps the real id as the LAST bracketed group even when content mimics an id suffix', () => {
    const outline = renderSubtreeOutline([
      row('real-id', null, 'see [some-other-block]'),
    ])
    expect(outline).toBe('- see [some-other-block]  [real-id]')
  })

  it('marks an empty result as root-missing-or-deleted', () => {
    expect(renderSubtreeOutline([])).toBe('(no blocks — root not found or deleted)')
  })

  it('falls back to raw JSON for a non-array payload', () => {
    const value = {ok: false, error: {message: 'boom'}}
    expect(renderSubtreeOutline(value)).toBe(JSON.stringify(value, null, 2))
  })
})

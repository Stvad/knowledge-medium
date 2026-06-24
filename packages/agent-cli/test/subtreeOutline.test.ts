import {describe, expect, it} from 'vitest'
import {renderSubtreeOutline, type SubtreeOutlineRow} from '../src/subtreeOutline'

/** Build a flat row in the shape the wire payload delivers (only the
 *  three fields the outline reads). */
const row = (id: string, parentId: string | null, content: string): SubtreeOutlineRow =>
  ({id, parentId, content})

describe('renderSubtreeOutline', () => {
  it('indents by depth and carries content + id on each line', () => {
    const outline = renderSubtreeOutline([
      row('root', null, 'Project Alpha'),
      row('a', 'root', 'Design notes'),
      row('a1', 'a', 'open question'),
      row('b', 'root', 'Tasks'),
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

  it('keeps the id on the first line of multi-line content, hanging continuations under the bullet', () => {
    const outline = renderSubtreeOutline([
      row('root', null, 'line one\nline two\nline three'),
    ])
    expect(outline).toBe(
      ['- line one  [root]', '  line two', '  line three'].join('\n'),
    )
  })

  it('renders an empty array as a clear marker', () => {
    expect(renderSubtreeOutline([])).toBe('(empty subtree)')
  })

  it('falls back to raw JSON for a non-array payload', () => {
    const value = {ok: false, error: {message: 'boom'}}
    expect(renderSubtreeOutline(value)).toBe(JSON.stringify(value, null, 2))
  })
})

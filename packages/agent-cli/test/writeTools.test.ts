import {describe, expect, it} from 'vitest'
import {AGENT_VIEW_DEFAULTS} from '../src/protocol'
import {renderAppendResult} from '../src/writeTools'

describe('renderAppendResult', () => {
  it('prints the target and the created blocks as a short-id outline', () => {
    const text = renderAppendResult({
      target: {id: 'p-full', shortId: '3aa279ad', kind: 'page', created: true, content: 'Reading list'},
      blocks: [
        {id: 'a', shortId: 'a1b2c3d4', parentId: 'p-full', depth: 0, content: 'a book'},
        {id: 'b', shortId: 'e5f6a7b8', parentId: 'a', depth: 1, content: '```\nconst x = 1\n```'},
      ],
    })
    expect(text).toBe([
      'Appended 2 blocks under "Reading list" ^3aa279ad (page, created):',
      '- a book  ^a1b2c3d4',
      '  - ``` …(+2 lines)  ^e5f6a7b8',
    ].join('\n'))
  })

  it('cannot be made to forge a line by a non-canonical id printed in full', () => {
    const text = renderAppendResult({
      target: {id: 't', shortId: 'ok', kind: 'block', created: false, content: 'T'},
      blocks: [{id: 'x\nfake', shortId: 'x\nAppended 0 blocks', parentId: 't', depth: 0, content: 'c'}],
    })
    expect(text.split('\n')).toHaveLength(2)
  })

  it('cannot be made to forge a line or reorder text by the target\'s content', () => {
    const text = renderAppendResult({
      target: {id: 't', shortId: 't', kind: 'block', created: false, content: 'evil\u202Eesrever'},
      blocks: [],
    })
    expect(text).not.toMatch(/\u202E/)
    expect(text.split('\n')).toHaveLength(1)
  })

  it('cuts a long line with the read views\' marker, so a long target paragraph is not echoed whole', () => {
    const long = 'p'.repeat(AGENT_VIEW_DEFAULTS.lineChars + 40)
    const text = renderAppendResult({
      target: {id: 't', shortId: 't', kind: 'block', created: false, content: long},
      blocks: [{id: 'b', shortId: 'b', parentId: 't', depth: 0, content: long}],
    })
    const kept = `${'p'.repeat(AGENT_VIEW_DEFAULTS.lineChars)}…[+40 chars]`
    expect(text).toBe([`Appended 1 block under "${kept}" ^t (block):`, `- ${kept}  ^b`].join('\n'))
  })
})

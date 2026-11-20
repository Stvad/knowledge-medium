import {describe, expect, it} from 'vitest'
import {diffMemory, renderMemoryChanges} from '../src/memory'

describe('diffMemory', () => {
  it('reports saved, edited and removed entries by id', () => {
    const diff = diffMemory(
      [{id: 'a', content: 'keep'}, {id: 'b', content: 'old wording'}, {id: 'c', content: 'gone'}],
      [{id: 'a', content: 'keep'}, {id: 'b', content: 'new wording'}, {id: 'd', content: 'fresh'}],
    )
    expect(diff).toEqual({
      saved: [{id: 'd', content: 'fresh'}],
      edited: [{id: 'b', content: 'new wording'}],
      removed: [{id: 'c', content: 'gone'}],
    })
  })
})

describe('renderMemoryChanges', () => {
  it('is null when nothing changed', () => {
    expect(renderMemoryChanges({saved: [], edited: [], removed: []})).toBeNull()
  })

  it('links saved and edited entries, and quotes removed ones with the id that restores them', () => {
    const line = renderMemoryChanges({
      saved: [{id: 'd', content: 'prefers suggestions over edits'}],
      edited: [{id: 'b', content: 'replies short'}],
      removed: [{id: 'c', content: 'uses roam'}],
    })
    expect(line).toBe(
      'Memory changed during this run: saved [prefers suggestions over edits](((d))); '
      + 'edited [replies short](((b))); removed "uses roam" (`c`)',
    )
  })

  it('writes no link, tag or line break of its own from entry text', () => {
    // Removed text is a hand-written entry the write guard never saw; the
    // reply is written outside it, so a [[watched page]] must not survive.
    const line = renderMemoryChanges({
      saved: [{id: 'd', content: 'see [[claude]] and ((x)) #tag\nsecond line'}],
      edited: [],
      removed: [{id: 'c', content: 'ask [[claude]]'}],
    })
    expect(line).not.toMatch(/\[\[|\(\(x|#tag|\n/)
    expect(line).toContain('(((d)))')
  })

  it('shortens long entries', () => {
    const line = renderMemoryChanges({saved: [{id: 'd', content: 'x'.repeat(500)}], edited: [], removed: []})
    expect(line!.length).toBeLessThan(150)
  })
})

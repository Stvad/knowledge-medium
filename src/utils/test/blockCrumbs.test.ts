import { describe, expect, it } from 'vitest'
import type { BlockData } from '@/data/api'
import { aliasesProp } from '@/data/properties.js'
import {
  CRUMB_MAX_CHARS,
  collapseCrumbs,
  crumbsFromAncestors,
} from '@/utils/blockCrumbs.js'

const ancestor = (
  id: string,
  content: string,
  properties: Record<string, unknown> = {},
): BlockData => ({
  id,
  content,
  properties,
  workspaceId: 'ws-1',
  parentId: null,
  orderKey: 'a0',
  updatedAt: 0,
  userUpdatedAt: 0,
  updatedBy: 'u1',
  deleted: false,
} as unknown as BlockData)

describe('crumbsFromAncestors', () => {
  it('reads root-first, reversing the leaf-to-root chain the query returns', () => {
    // core.manyAncestors returns depth-ascending (immediate parent first).
    const crumbs = crumbsFromAncestors([
      ancestor('parent', 'Meeting notes'),
      ancestor('grandparent', 'Q3'),
      ancestor('root', 'Project Alpha'),
    ])

    expect(crumbs).toEqual(['Project Alpha', 'Q3', 'Meeting notes'])
  })

  it('prefers a page alias over its body content', () => {
    const crumbs = crumbsFromAncestors([
      ancestor('root', 'first line of the page body', {[aliasesProp.name]: ['Project Alpha']}),
    ])

    expect(crumbs).toEqual(['Project Alpha'])
  })

  it('drops blank ancestors instead of rendering an empty segment', () => {
    const crumbs = crumbsFromAncestors([
      ancestor('parent', 'Notes'),
      ancestor('blank', '   '),
      ancestor('root', 'Project Alpha'),
    ])

    expect(crumbs).toEqual(['Project Alpha', 'Notes'])
  })

  it('keeps a crumb to one line of collapsed whitespace', () => {
    const crumbs = crumbsFromAncestors([
      ancestor('parent', 'Weekly  sync\nsecond line that must not appear'),
    ])

    expect(crumbs).toEqual(['Weekly sync'])
  })

  it('truncates a long crumb so one ancestor cannot eat the whole line', () => {
    const long = 'A'.repeat(CRUMB_MAX_CHARS * 2)

    const [crumb] = crumbsFromAncestors([ancestor('parent', long)])

    expect(crumb).toHaveLength(CRUMB_MAX_CHARS)
    expect(crumb.endsWith('…')).toBe(true)
  })
})

describe('collapseCrumbs', () => {
  it('leaves a chain that fits alone', () => {
    expect(collapseCrumbs(['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('keeps the root and the nearest ancestors, eliding the middle', () => {
    // The root says which page, the tail says which section — the middle
    // is the part that locates nothing.
    expect(collapseCrumbs(['root', 'x', 'y', 'z', 'parent']))
      .toEqual(['root', '…', 'z', 'parent'])
  })
})

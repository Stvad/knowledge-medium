import { describe, expect, it } from 'vitest'
import type { BlockData } from '@/data/api'
import { aliasesProp } from '@/data/properties.js'
import {
  CRUMB_MAX_CHARS,
  CRUMB_MAX_SEGMENTS,
  collapseCrumbs,
  crumbsFromAncestors,
} from '@/utils/blockCrumbs.js'

const WS = 'ws-1'

const ancestor = (
  id: string,
  content: string,
  {properties = {}, parentId = null, workspaceId = WS, isFieldForm = false}: {
    properties?: Record<string, unknown>
    parentId?: string | null
    workspaceId?: string
    isFieldForm?: boolean
  } = {},
): BlockData => ({
  id,
  content,
  properties,
  workspaceId,
  parentId,
  isFieldForm,
  orderKey: 'a0',
  updatedAt: 0,
  userUpdatedAt: 0,
  updatedBy: 'u1',
  deleted: false,
} as unknown as BlockData)

/** The common case: a nested block whose chain we're rendering. `parentId`
 *  is what tells a genuine root from a block whose parent was excluded
 *  from the walk, so it has to be explicit at every call site. */
const crumbsOf = (ancestors: BlockData[], parentId: string | null = 'parent') =>
  crumbsFromAncestors(ancestors, {workspaceId: WS, parentId})

describe('crumbsFromAncestors', () => {
  it('reads root-first, reversing the leaf-to-root chain the query returns', () => {
    // core.manyAncestors returns depth-ascending (immediate parent first).
    const crumbs = crumbsOf([
      ancestor('parent', 'Meeting notes', {parentId: 'grandparent'}),
      ancestor('grandparent', 'Q3', {parentId: 'root'}),
      ancestor('root', 'Project Alpha'),
    ])

    expect(crumbs).toEqual(['Project Alpha', 'Q3', 'Meeting notes'])
  })

  it('prefers a page alias over its body content', () => {
    const crumbs = crumbsOf([
      ancestor('root', 'first line of the page body', {
        properties: {[aliasesProp.name]: ['Project Alpha']},
      }),
    ])

    expect(crumbs).toEqual(['Project Alpha'])
  })

  it('drops blank ancestors instead of rendering an empty segment', () => {
    const crumbs = crumbsOf([
      ancestor('parent', 'Notes', {parentId: 'blank'}),
      ancestor('blank', '   ', {parentId: 'root'}),
      ancestor('root', 'Project Alpha'),
    ])

    expect(crumbs).toEqual(['Project Alpha', 'Notes'])
  })

  it('keeps a crumb to one line of collapsed whitespace', () => {
    const crumbs = crumbsOf([
      ancestor('parent', 'Weekly  sync\nsecond line that must not appear'),
    ])

    expect(crumbs).toEqual(['Weekly sync'])
  })

  it('truncates a long crumb so one ancestor cannot eat the whole line', () => {
    const long = 'A'.repeat(CRUMB_MAX_CHARS * 2)

    const [crumb] = crumbsOf([ancestor('parent', long)])

    expect(crumb).toHaveLength(CRUMB_MAX_CHARS)
    expect(crumb).toContain('…')
  })

  it('keeps sibling PAGE TITLES apart when they share a long prefix', () => {
    // The failure this whole feature exists to prevent, one level down:
    // end-truncation renders both of these as "Quarterly Planning Meet…",
    // so two different rows become byte-identical again.
    const titled = (id: string, alias: string) =>
      ancestor(id, 'body text', {properties: {[aliasesProp.name]: [alias]}})
    const [y2026] = crumbsOf([titled('a', 'Quarterly Planning Meeting Notes 2026')])
    const [y2027] = crumbsOf([titled('b', 'Quarterly Planning Meeting Notes 2027')])

    expect(y2026).not.toEqual(y2027)
    expect(y2026).toContain('2026')
    expect(y2027).toContain('2027')
  })

  it('cuts a PROSE ancestor at the end, where there is no meaningful tail', () => {
    // Splicing the last characters of a sentence onto its opening reads as
    // damage ("Fold a block…llet below.") and distinguishes nothing.
    const [crumb] = crumbsOf([
      ancestor('parent', 'Fold a block\u2019s children: press z, then try the bullet below.'),
    ])

    expect(crumb.endsWith('\u2026')).toBe(true)
    expect(crumb.startsWith('Fold a block')).toBe(true)
  })
})

describe('crumbsFromAncestors: chains that do not reach a root', () => {
  it('marks a chain cut short by a soft-deleted ancestor', () => {
    // The SQL filters `deleted = 0`, so the walk STOPS at a tombstoned
    // parent rather than stepping over it — the surviving fragment's top
    // still points at a parent. Rendering it plainly would name "Meeting
    // notes" as the page this block lives on, with the real page silently
    // gone.
    const crumbs = crumbsOf([
      ancestor('parent', 'Meeting notes', {parentId: 'deleted-section'}),
    ])

    expect(crumbs).toEqual(['…', 'Meeting notes'])
  })

  it('marks a block whose IMMEDIATE parent is gone', () => {
    // The likeliest cut of all — `core.restore` brings back one block and
    // leaves a live child under a tombstone — and the one an empty
    // ancestors array cannot express on its own: a genuine top-level
    // block returns exactly the same `[]`. Only the block's own parent
    // edge separates them, so it is the thing that must decide.
    expect(crumbsOf([], 'deleted-parent')).toEqual(['…'])
  })

  it('leaves a genuine top-level block with no crumbs at all', () => {
    // The contrast case for the one above: same empty chain, no marker,
    // because this block really has nothing above it.
    expect(crumbsOf([], null)).toEqual([])
  })

  it('shows only the marker when the chain leaves the workspace at once', () => {
    expect(crumbsFromAncestors(
      [ancestor('foreign', 'Other workspace page', {workspaceId: 'ws-2'})],
      {workspaceId: WS, parentId: 'foreign'},
    )).toEqual(['…'])
  })

  it('stops at a workspace boundary rather than showing another workspace', () => {
    // `manyAncestorsSql` has no workspace predicate and sync arrival
    // applies parent_id without re-validating it, so this is the last
    // line of defence against rendering a foreign workspace's content.
    const crumbs = crumbsFromAncestors([
      ancestor('parent', 'My section', {parentId: 'foreign-root'}),
      ancestor('foreign-root', 'Someone else private page', {workspaceId: 'ws-2'}),
    ], {workspaceId: WS, parentId: 'parent'})

    expect(crumbs).toEqual(['…', 'My section'])
  })

  it('keeps only the nearest ancestors when a cut chain is also long', () => {
    const deep = Array.from({length: 8}, (_, i) =>
      ancestor(`a${i}`, `level ${i}`, {parentId: `a${i + 1}`}))

    expect(crumbsOf(deep)).toEqual(['…', 'level 2', 'level 1', 'level 0'])
  })
})

describe('crumbsFromAncestors: property machinery', () => {
  it('drops field rows instead of rendering their raw reference syntax', () => {
    // A field row's content is literally `::((fieldId))`; every other
    // surface in the app treats these as invisible machinery.
    const crumbs = crumbsOf([
      ancestor('field', '::((field-def-status-0000))', {
        parentId: 'owner',
        isFieldForm: true,
      }),
      ancestor('owner', 'Task Board'),
    ])

    expect(crumbs).toEqual(['Task Board'])
  })

  it('still reaches the owner above a dropped field row', () => {
    const crumbs = crumbsOf([
      ancestor('value', 'Done', {parentId: 'field'}),
      ancestor('field', '::((field-def-status-0000))', {
        parentId: 'owner',
        isFieldForm: true,
      }),
      ancestor('owner', 'Task Board'),
    ])

    expect(crumbs).toEqual(['Task Board', 'Done'])
  })
})

describe('collapseCrumbs', () => {
  it('leaves a chain that fits alone', () => {
    expect(collapseCrumbs(['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('leaves a chain sitting exactly on the cap alone', () => {
    // The `<=` boundary: flipping it to `<` elides a chain that fits.
    const exact = ['root', 'x', 'y', 'parent']
    expect(exact).toHaveLength(CRUMB_MAX_SEGMENTS)
    expect(collapseCrumbs(exact)).toEqual(exact)
  })

  it('keeps the root and the nearest ancestors, eliding the middle', () => {
    // The root says which page, the tail says which section — the middle
    // is the part that locates nothing.
    expect(collapseCrumbs(['root', 'x', 'y', 'z', 'parent']))
      .toEqual(['root', '…', 'z', 'parent'])
  })
})

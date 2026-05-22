/**
 * Tree-discovery walks for the settings UI.
 *
 * Mirrors the resolver walk pair (sync/async) but without the
 * boundary filter — settings has to show *every* togglable, including
 * the disabled ones, so the user can re-enable them. Recursion
 * differences vs the resolver:
 *
 *   - boundary arrays produce a `ToggleNode` and child-walks descend
 *     into its `children` rather than the flat output list
 *   - non-boundary arrays descend into the *current* sink (children
 *     get the parent's container)
 *   - FacetContribution.enables walks into the current sink — enables
 *     are drag-along siblings, not children of a contribution row
 *   - sync throws on function-valued extensions (same policy as the
 *     resolver); async awaits + recurses
 */
import {describe, expect, it, vi} from 'vitest'
import {defineFacet, type AppExtension} from '@/extensions/facet.js'
import {systemToggle, type Togglable} from '@/extensions/togglable.js'
import {
  discoverToggleTree,
  discoverToggleTreeSync,
} from '@/extensions/discoverToggleTree.js'

const labels = defineFacet<string, string>({
  id: 'discover.labels',
  combine: vs => vs.join(','),
  empty: () => '',
})

const allIds = (nodes: ReadonlyArray<{handle: Togglable; children: ReadonlyArray<unknown>}>): string[] =>
  nodes.map(n => n.handle.id)

describe('discoverToggleTreeSync', () => {
  it('returns an empty array for an empty / nullish tree', () => {
    expect(discoverToggleTreeSync([])).toEqual([])
    expect(discoverToggleTreeSync(null)).toEqual([])
    expect(discoverToggleTreeSync(undefined)).toEqual([])
    expect(discoverToggleTreeSync(false)).toEqual([])
  })

  it('returns one root per top-level togglable boundary', () => {
    const a = systemToggle({id: 'system:a', name: 'A'})
    const b = systemToggle({id: 'system:b', name: 'B'})
    const tree = [a.of([]), b.of([])]

    const result = discoverToggleTreeSync(tree)

    expect(allIds(result)).toEqual(['system:a', 'system:b'])
    expect(result[0].children).toEqual([])
    expect(result[1].children).toEqual([])
  })

  it('nests togglables under their enclosing boundary', () => {
    const outer = systemToggle({id: 'system:outer', name: 'Outer'})
    const inner = systemToggle({id: 'system:inner', name: 'Inner'})
    const tree = outer.of([inner.of([])])

    const result = discoverToggleTreeSync(tree)

    expect(allIds(result)).toEqual(['system:outer'])
    expect(allIds(result[0].children as never)).toEqual(['system:inner'])
  })

  it('includes disabled togglables — settings shows everything so the user can re-enable', () => {
    // discoverToggleTree does not consult overrides; that's the point.
    const handle = systemToggle({
      id: 'system:disabled',
      name: 'Disabled',
      defaultEnabled: false,
    })
    const result = discoverToggleTreeSync([handle.of([labels.of('x')])])
    expect(allIds(result)).toEqual(['system:disabled'])
  })

  it('descends through non-boundary arrays into the current sink', () => {
    const handle = systemToggle({id: 'system:flat', name: 'Flat'})
    // Wrapper array has no boundary; the togglable inside should still
    // surface as a top-level root.
    const wrappedNoBoundary: AppExtension = [[handle.of([])]]
    const result = discoverToggleTreeSync(wrappedNoBoundary)
    expect(allIds(result)).toEqual(['system:flat'])
  })

  it('recurses into FacetContribution.enables — discovered togglables surface as siblings', () => {
    const dragged = systemToggle({id: 'system:dragged', name: 'Dragged'})
    const tree: AppExtension = labels.of('parent', {enables: dragged.of([])})

    const result = discoverToggleTreeSync(tree)

    expect(allIds(result)).toEqual(['system:dragged'])
  })

  it('a togglable inside enables nests under the enclosing boundary, not the contribution', () => {
    const outer = systemToggle({id: 'system:outer-en', name: 'Outer'})
    const dragged = systemToggle({id: 'system:dragged-en', name: 'Dragged'})

    const tree = outer.of([
      labels.of('parent', {enables: dragged.of([])}),
    ])

    const result = discoverToggleTreeSync(tree)

    expect(allIds(result)).toEqual(['system:outer-en'])
    expect(allIds(result[0].children as never)).toEqual(['system:dragged-en'])
  })

  it('throws on function-valued nodes (matches collector sync policy)', () => {
    expect(() =>
      discoverToggleTreeSync(() => []),
    ).toThrow(/function-valued AppExtension/i)
  })

  it('deduplicates roots that share a handle reference', () => {
    const handle = systemToggle({id: 'system:dup', name: 'Dup'})
    const tree = [handle.of([]), handle.of([])]

    const result = discoverToggleTreeSync(tree)

    // Two wraps of the same handle = two separate boundary arrays.
    // Each surfaces as a node, but the *handles* are identical. The
    // settings UI keys by handle.id, so this is informational —
    // codify the current behaviour rather than enforce dedup.
    expect(allIds(result)).toEqual(['system:dup', 'system:dup'])
  })
})

describe('discoverToggleTree (async)', () => {
  it('awaits function nodes and walks their result', async () => {
    const handle = systemToggle({id: 'system:from-fn', name: 'FromFn'})
    const tree: AppExtension = async () => [handle.of([])]

    const result = await discoverToggleTree(tree, {})

    expect(allIds(result)).toEqual(['system:from-fn'])
  })

  it('swallows function rejection with a console.error rather than aborting the walk', async () => {
    const handle = systemToggle({id: 'system:survived', name: 'Survived'})
    const tree: AppExtension = [
      async () => { throw new Error('boom') },
      handle.of([]),
    ]

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const result = await discoverToggleTree(tree, {})
      expect(allIds(result)).toEqual(['system:survived'])
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      error.mockRestore()
    }
  })

  it('passes the supplied context to function nodes', async () => {
    const seen: Array<Record<string, unknown>> = []
    const handle = systemToggle({id: 'system:ctx', name: 'Ctx'})
    const tree: AppExtension = (ctx) => {
      seen.push(ctx as Record<string, unknown>)
      return handle.of([])
    }

    await discoverToggleTree(tree, {workspaceId: 'ws-1', safeMode: false})

    expect(seen[0]).toEqual({workspaceId: 'ws-1', safeMode: false})
  })

  it('matches the sync variant on a function-free tree', async () => {
    const outer = systemToggle({id: 'system:m-outer', name: 'Outer'})
    const inner = systemToggle({id: 'system:m-inner', name: 'Inner'})
    const tree = outer.of([inner.of([])])

    const asyncResult = await discoverToggleTree(tree, {})
    const syncResult = discoverToggleTreeSync(tree)

    expect(asyncResult).toEqual(syncResult)
  })
})

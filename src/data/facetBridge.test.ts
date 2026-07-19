// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { TypeContribution } from '@/data/api'
import { mergeCodeAndRegistryTypes } from '@/data/facetBridge'

/** The C3b behavior-neutrality invariant lives here: `repo.types` is no longer a
 *  single `keyedMapFacet` fold over `typesFacet` (static code contributions +
 *  the `userTypesProjector`'s `'user-data'` bucket). It's now
 *  `mergeCodeAndRegistryTypes(rt.read(typesFacet), typeRegistry)`. This pins that
 *  the merge reproduces the OLD fold's two load-bearing properties — iteration
 *  order (code first, then user/seed; `liftTypeSchemas` is last-wins BY NAME over
 *  `types.values()`, so order decides its winners) and last-wins precedence on a
 *  same-id collision (the old fold's user-data bucket was appended after static,
 *  so it won). A later change (adding `precedence` to a `typesFacet.of`, or C4's
 *  `typesFacet.of → seedType` conversion introducing the first real code/seed id
 *  overlap) that broke this would surface here rather than as a silent drift. */

const code = (id: string, label: string): TypeContribution => ({ id, label })

// The overlay `mergeCodeAndRegistryTypes` merges is just the `typesById`-shaped
// map — the registry's slice when pinned, or `buildUnboundTypes` before a pin.
const overlayOf = (types: readonly TypeContribution[]): ReadonlyMap<string, TypeContribution> =>
  new Map(types.map(t => [t.id, t]))

describe('mergeCodeAndRegistryTypes', () => {
  const codeTypes = new Map([
    ['page', code('page', 'Page')],
    ['todo', code('todo', 'Todo')],
  ])

  it('returns the code map unchanged when there is no registry', () => {
    expect(mergeCodeAndRegistryTypes(codeTypes, null)).toBe(codeTypes)
  })

  it('returns the code map unchanged when the registry has no types', () => {
    expect(mergeCodeAndRegistryTypes(codeTypes, overlayOf([]))).toBe(codeTypes)
  })

  it('appends registry (user/seed) entries after the code entries, disjoint union', () => {
    const merged = mergeCodeAndRegistryTypes(
      codeTypes,
      overlayOf([code('uuid-a', 'Task'), code('uuid-b', 'Note')]),
    )
    // Order matches the old fold: static code first, user-data bucket appended.
    expect([...merged.keys()]).toEqual(['page', 'todo', 'uuid-a', 'uuid-b'])
    expect(merged.get('uuid-a')).toMatchObject({ label: 'Task' })
    // Does not mutate the input code map.
    expect([...codeTypes.keys()]).toEqual(['page', 'todo'])
  })

  it('lets a registry entry win a same-id collision, keeping the id in place (last-wins, no reorder)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const merged = mergeCodeAndRegistryTypes(
        codeTypes,
        overlayOf([code('todo', 'Todo (block-built)')]),
      )
      // Registry wins the value...
      expect(merged.get('todo')).toMatchObject({ label: 'Todo (block-built)' })
      // ...and the collided id stays at its original position (Map.set updates in
      // place — exactly the old single-fold's overwrite-in-place semantics).
      expect([...merged.keys()]).toEqual(['page', 'todo'])
      // The overwrite is observable (the old keyedMapFacet fold warned; a raw
      // .set() would have gone silent).
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]![0]).toContain('todo')
    } finally {
      warn.mockRestore()
    }
  })
})

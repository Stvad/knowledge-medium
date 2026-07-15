import { describe, expect, it } from 'vitest'
import { resolveStructuralEditPolicy } from '../structuralEditPolicy.ts'

const policy = (over: Partial<Parameters<typeof resolveStructuralEditPolicy>[0]> = {}) =>
  resolveStructuralEditPolicy({
    blockId: 'b',
    parentId: 'p',
    hasUncollapsedChildren: false,
    scopeRootId: 'root',
    ...over,
  })

describe('resolveStructuralEditPolicy', () => {
  describe('non-scope-root block', () => {
    it('creates a sibling below when it has no visible children', () => {
      expect(policy().createBelowPlacement).toBe('sibling-below')
    })

    it('creates a first child when it has visible children', () => {
      expect(policy({hasUncollapsedChildren: true}).createBelowPlacement).toBe('child-first')
    })

    it('creates a sibling above regardless of children', () => {
      expect(policy().createAbovePlacement).toBe('sibling-above')
      expect(policy({hasUncollapsedChildren: true}).createAbovePlacement).toBe('sibling-above')
    })

    it('allows indent / outdent / merge-up / delete', () => {
      const p = policy({parentId: 'somewhere-else'})
      expect(p).toMatchObject({canIndent: true, canOutdent: true, canMergeUp: true, canDelete: true, isScopeRoot: false})
    })

    it('refuses to outdent past the scope boundary (direct child of root)', () => {
      expect(policy({parentId: 'root'}).canOutdent).toBe(false)
    })
  })

  describe('scope-root block', () => {
    const root = (over: Partial<Parameters<typeof resolveStructuralEditPolicy>[0]> = {}) =>
      policy({blockId: 'root', parentId: 'real-parent', ...over})

    it('always creates a first child so the new block stays visible', () => {
      expect(root().createBelowPlacement).toBe('child-first')
      expect(root({hasUncollapsedChildren: true}).createBelowPlacement).toBe('child-first')
    })

    it('creates a first child for `O` too, since a sibling above is outside the surface', () => {
      expect(root().createAbovePlacement).toBe('child-first')
      expect(root({hasUncollapsedChildren: true}).createAbovePlacement).toBe('child-first')
    })

    it('is a no-op for indent / outdent / merge-up / delete', () => {
      expect(root()).toMatchObject({
        isScopeRoot: true,
        canIndent: false,
        canOutdent: false,
        canMergeUp: false,
        // Deleting the scope root would tombstone the whole rendered
        // surface (found by defaultActions.fuzz.test.ts).
        canDelete: false,
      })
    })
  })

  it('treats nothing as a scope root when scopeRootId is undefined', () => {
    const p = policy({scopeRootId: undefined})
    expect(p.isScopeRoot).toBe(false)
    expect(p.canIndent).toBe(true)
    // The agent bridge (no injectable scope) must remain free to delete.
    expect(p.canDelete).toBe(true)
    // Imperative/CLI dispatch (no surface): `O` falls back to a plain
    // sibling-above rather than no-oping.
    expect(p.createAbovePlacement).toBe('sibling-above')
  })
})

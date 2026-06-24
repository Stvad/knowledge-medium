// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { BlockResolveContext } from '@/extensions/blockInteraction.js'
import { discoverToggleTreeSync, type ToggleNode } from '@/facets/discoverToggleTree.js'
import { isEnabled } from '@/facets/togglable.js'
import { backlinksPlugin } from '../../index.ts'
import { inlineBacklinksApplies } from '../applies.ts'
import {
  inlineBacklinkCountDecoratorContribution,
  inlineBacklinkExpansionFooterContribution,
} from '../InlineBacklinkCount.tsx'

/** Minimal `BlockResolveContext` — the inline-counts gate reads only
 *  `isTopLevel` + `blockContext.isNestedSurface`. */
const ctx = (over: Partial<BlockResolveContext>): BlockResolveContext =>
  ({ isTopLevel: false, ...over }) as BlockResolveContext

const FOCAL = ctx({ isTopLevel: true })
const NESTED = ctx({ blockContext: { isNestedSurface: true } as BlockResolveContext['blockContext'] })
const FOCAL_EMBED = ctx({
  isTopLevel: true,
  blockContext: { isNestedSurface: true } as BlockResolveContext['blockContext'],
})
const REGULAR = ctx({})

const findNode = (nodes: ToggleNode[], id: string): ToggleNode | undefined => {
  for (const node of nodes) {
    if (node.handle.id === id) return node
    const inChild = findNode(node.children, id)
    if (inChild) return inChild
  }
  return undefined
}

describe('inlineBacklinksApplies gate', () => {
  it('skips the focal block (its full references already render below it)', () => {
    expect(inlineBacklinksApplies(FOCAL)).toBe(false)
  })

  it('skips nested surfaces (embeds, backlink entries, breadcrumbs)', () => {
    expect(inlineBacklinksApplies(NESTED)).toBe(false)
    // A focal block re-rendered inside an embed is still a nested surface.
    expect(inlineBacklinksApplies(FOCAL_EMBED)).toBe(false)
  })

  it('applies to ordinary non-focal document blocks', () => {
    expect(inlineBacklinksApplies(REGULAR)).toBe(true)
  })
})

describe('inline-counts facet contributions', () => {
  it('decorate + footer attach only where the gate applies', () => {
    expect(inlineBacklinkCountDecoratorContribution(REGULAR)).toBeTruthy()
    expect(inlineBacklinkExpansionFooterContribution(REGULAR)).toBeTruthy()

    for (const skipped of [FOCAL, NESTED]) {
      expect(inlineBacklinkCountDecoratorContribution(skipped)).toBeNull()
      expect(inlineBacklinkExpansionFooterContribution(skipped)).toBeNull()
    }
  })
})

describe('inline-counts sub-toggle wiring', () => {
  it('is a nested sub-toggle under the backlinks plugin, enabled by default', () => {
    const tree = discoverToggleTreeSync(backlinksPlugin)
    const backlinks = findNode(tree, 'system:backlinks')
    expect(backlinks).toBeDefined()

    const inlineCounts = backlinks!.children.find(
      (child) => child.handle.id === 'system:backlinks/inline-counts',
    )
    expect(inlineCounts).toBeDefined()
    // defaultEnabled omitted ⇒ on; no override present ⇒ enabled.
    expect(isEnabled(inlineCounts!.handle, new Map())).toBe(true)
    // ...and honours an explicit off override.
    expect(isEnabled(inlineCounts!.handle, new Map([['system:backlinks/inline-counts', false]]))).toBe(false)
  })
})

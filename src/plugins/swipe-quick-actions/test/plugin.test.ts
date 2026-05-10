import { describe, expect, it } from 'vitest'
import { panelMountsFacet } from '@/extensions/core.ts'
import { blockContentSurfacePropsFacet } from '@/extensions/blockInteraction.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  SwipeActionMenu,
  quickActionItemsFacet,
  swipeQuickActionsPlugin,
} from '../index.ts'

describe('swipeQuickActionsPlugin', () => {
  it('contributes the gesture surface, menu mount, and action items', () => {
    const runtime = resolveFacetRuntimeSync(swipeQuickActionsPlugin)
    const panelMounts = runtime.read(panelMountsFacet)
    const items = runtime.read(quickActionItemsFacet)

    expect(runtime.contributions(blockContentSurfacePropsFacet)).toHaveLength(1)
    expect(panelMounts).toEqual([
      {
        id: 'swipe-quick-actions.panel-menu',
        component: SwipeActionMenu,
      },
    ])
    expect(items.map(item => [item.actionId, item.overflow === true])).toEqual([
      ['copy_block', false],
      ['copy_block_ref', false],
      ['open_focused_in_panel', false],
      ['delete_block', false],
      ['zoom_in', true],
      ['toggle_collapse', true],
      ['toggle_properties', true],
      ['copy_block_embed', true],
    ])
  })
})

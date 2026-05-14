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
    expect(items.map(item => [item.actionId, item.overflow === true, item.row ?? 1])).toEqual([
      ['copy_block', false, 1],
      ['copy_block_ref', false, 1],
      ['open_focused_in_panel', false, 1],
      ['toggle_properties', false, 1],
      ['delete_block', false, 1],
      ['zoom_in', true, 1],
      ['toggle_collapse', true, 1],
      ['copy_block_embed', true, 1],
    ])
  })
})

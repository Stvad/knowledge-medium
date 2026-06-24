import { describe, expect, it } from 'vitest'
import { actionsFacet, panelMountsFacet } from '@/extensions/core.js'
import { continuousGestureRecognizersFacet } from '@/extensions/continuousGestures.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import {
  SwipeActionMenu,
  quickActionItemsFacet,
  swipeQuickActionsPlugin,
} from '../index.ts'

describe('swipeQuickActionsPlugin', () => {
  it('contributes the gesture recognizer, swipe actions, menu mount, and action items', () => {
    const runtime = resolveFacetRuntimeSync(swipeQuickActionsPlugin)
    const panelMounts = runtime.read(panelMountsFacet)
    const items = runtime.read(quickActionItemsFacet)
    const actionIds = runtime.read(actionsFacet).map(a => a.id)

    // Recognition rides the continuous-gesture loop now (not a raw content surface).
    expect(runtime.contributions(continuousGestureRecognizersFacet)).toHaveLength(1)
    // Swipe-left's behavior is two gesture-bound actions (reveal preview + open);
    // swipe-right's primary behavior is the todo cycle action from that plugin,
    // with a declinable close fallback here so disabling Todo still closes the menu.
    expect(actionIds).toEqual(
      expect.arrayContaining([
        'swipe-quick-actions.reveal',
        'swipe-quick-actions.open',
        'swipe-quick-actions.close',
      ]),
    )
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

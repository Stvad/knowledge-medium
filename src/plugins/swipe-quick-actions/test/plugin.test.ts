// @vitest-environment happy-dom
// (only for `getDefaultActionGroups`, which installs a `window` metrics hook)

import { describe, expect, it } from 'vitest'
import type { Repo } from '@/data/repo.js'
import { getDefaultActionGroups } from '@/shortcuts/defaultShortcuts.js'
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

  it('every default item names an action a default install actually registers', () => {
    // The menu keeps items whose action is missing (deliberate — a plugin can
    // contribute the action later) and only discovers the gap when the user
    // taps: it logs "not registered" and dismisses. So `delete_block`,
    // `toggle_properties` and `toggle_collapse` shipped as dead buttons for
    // anyone without the opt-in vim plugin, which was their only definer.
    // Assert the referenced ids against the DEFAULT action set, not against a
    // runtime that happens to have vim loaded.
    const repo = {} as Repo
    const defaultIds = new Set(
      Object.values(getDefaultActionGroups({repo})).flat().map(action => action.id),
    )
    const items = resolveFacetRuntimeSync(swipeQuickActionsPlugin).read(quickActionItemsFacet)
    expect(items.map(item => item.actionId).filter(id => !defaultIds.has(id))).toEqual([])
  })
})

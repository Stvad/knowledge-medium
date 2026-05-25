import { describe, expect, it } from 'vitest'
import { actionContextsFacet, actionsFacet, appMountsFacet, headerItemsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { quickActionItemsFacet } from '@/plugins/swipe-quick-actions'
import { ActionContextTypes } from '@/shortcuts/types.js'
import {
  COMMAND_PALETTE_FOR_BLOCK_ACTION_ID,
  commandPaletteAction,
  commandPaletteActionContext,
  commandPaletteForBlockAction,
  commandPaletteForBlockQuickAction,
  commandPaletteHeaderItem,
  commandPaletteMount,
  commandPalettePlugin,
} from '../index.ts'

describe('commandPalettePlugin', () => {
  it('contributes the command palette mount and action', () => {
    const runtime = resolveFacetRuntimeSync(commandPalettePlugin)

    expect(runtime.read(appMountsFacet)).toEqual([commandPaletteMount])
    expect(runtime.read(actionContextsFacet)).toEqual([commandPaletteActionContext])
    expect(runtime.read(actionsFacet)).toEqual([
      commandPaletteAction,
      commandPaletteForBlockAction,
    ])
    expect(runtime.read(headerItemsFacet)).toEqual([commandPaletteHeaderItem])
    expect(commandPaletteAction.defaultBinding?.keys).toBe('$mod+k')
  })

  it('contributes a swipe quick-action that opens the palette for the swiped block', () => {
    const runtime = resolveFacetRuntimeSync(commandPalettePlugin)
    const items = runtime.read(quickActionItemsFacet)

    expect(items).toEqual([commandPaletteForBlockQuickAction])
    expect(commandPaletteForBlockQuickAction.actionId).toBe(COMMAND_PALETTE_FOR_BLOCK_ACTION_ID)
    expect(commandPaletteForBlockAction.context).toBe(ActionContextTypes.NORMAL_MODE)
    // No default binding: cmd+k already binds the global variant.
    expect(commandPaletteForBlockAction.defaultBinding).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { actionContextsFacet, actionsFacet, appMountsFacet, headerItemsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  commandPaletteAction,
  commandPaletteActionContext,
  commandPaletteHeaderItem,
  commandPaletteMount,
  commandPalettePlugin,
} from '../index.ts'

describe('commandPalettePlugin', () => {
  it('contributes the command palette mount and action', () => {
    const runtime = resolveFacetRuntimeSync(commandPalettePlugin)

    expect(runtime.read(appMountsFacet)).toEqual([commandPaletteMount])
    expect(runtime.read(actionContextsFacet)).toEqual([commandPaletteActionContext])
    expect(runtime.read(actionsFacet)).toEqual([commandPaletteAction])
    expect(runtime.read(headerItemsFacet)).toEqual([commandPaletteHeaderItem])
    expect(commandPaletteAction.defaultBinding?.keys).toEqual(['cmd+k', 'ctrl+k'])
  })
})

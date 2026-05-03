import { describe, expect, it } from 'vitest'
import { actionsFacet, appMountsFacet, headerItemsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  commandPaletteAction,
  commandPaletteHeaderItem,
  commandPaletteMount,
  commandPalettePlugin,
} from '../index.ts'

describe('commandPalettePlugin', () => {
  it('contributes the command palette mount and action', () => {
    const runtime = resolveFacetRuntimeSync(commandPalettePlugin)

    expect(runtime.read(appMountsFacet)).toEqual([commandPaletteMount])
    expect(runtime.read(actionsFacet)).toEqual([commandPaletteAction])
    expect(runtime.read(headerItemsFacet)).toEqual([commandPaletteHeaderItem])
    expect(commandPaletteAction.defaultBinding?.keys).toEqual(['cmd+k', 'ctrl+k'])
    expect(commandPaletteAction.hideFromCommandPallet).toBe(true)
  })
})

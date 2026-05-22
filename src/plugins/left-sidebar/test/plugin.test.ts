import { describe, expect, it } from 'vitest'
import { actionsFacet, appMountsFacet, headerItemsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import {
  leftSidebarCoreSection,
  leftSidebarHeaderItem,
  leftSidebarMount,
  leftSidebarPlugin,
  leftSidebarSectionsFacet,
  leftSidebarShortcutsSection,
  openLeftSidebarAction,
} from '../index.ts'

describe('leftSidebarPlugin', () => {
  it('contributes the sidebar mount, header trigger, and default sections', () => {
    const runtime = resolveFacetRuntimeSync(leftSidebarPlugin)

    expect(runtime.read(appMountsFacet)).toEqual([leftSidebarMount])
    expect(runtime.read(headerItemsFacet)).toEqual([leftSidebarHeaderItem])
    expect(runtime.read(actionsFacet)).toEqual([
      openLeftSidebarAction,
    ])
    expect(runtime.read(leftSidebarSectionsFacet)).toEqual([
      leftSidebarCoreSection,
      leftSidebarShortcutsSection,
    ])
  })
})

import { describe, expect, it } from 'vitest'
import { appMountsFacet, headerItemsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  leftSidebarCoreSection,
  leftSidebarHeaderItem,
  leftSidebarMount,
  leftSidebarPlugin,
  leftSidebarSectionsFacet,
  leftSidebarShortcutsSection,
} from '../index.ts'

describe('leftSidebarPlugin', () => {
  it('contributes the sidebar mount, header trigger, and default sections', () => {
    const runtime = resolveFacetRuntimeSync(leftSidebarPlugin)

    expect(runtime.read(appMountsFacet)).toEqual([leftSidebarMount])
    expect(runtime.read(headerItemsFacet)).toEqual([leftSidebarHeaderItem])
    expect(runtime.read(leftSidebarSectionsFacet)).toEqual([
      leftSidebarCoreSection,
      leftSidebarShortcutsSection,
    ])
  })
})

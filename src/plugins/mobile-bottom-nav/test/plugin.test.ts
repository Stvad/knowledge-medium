import { describe, expect, it } from 'vitest'
import { appMountsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  appendTodayDailyBlockBottomNavItem,
  commandPaletteBottomNavItem,
  MobileBottomNav,
  mobileBottomNavItemsFacet,
  mobileBottomNavMount,
  mobileBottomNavPlugin,
  newNodeBottomNavItem,
  openSidebarBottomNavItem,
  searchBottomNavItem,
  todayBottomNavItem,
} from '../index.ts'

describe('mobileBottomNavPlugin', () => {
  it('contributes the mobile bottom navigation mount', () => {
    const runtime = resolveFacetRuntimeSync(mobileBottomNavPlugin)

    expect(runtime.read(appMountsFacet)).toEqual([mobileBottomNavMount])
    expect(mobileBottomNavMount.component).toBe(MobileBottomNav)
  })

  it('contributes the default bottom navigation items through a facet', () => {
    const runtime = resolveFacetRuntimeSync(mobileBottomNavPlugin)

    expect(runtime.read(mobileBottomNavItemsFacet)).toEqual([
      openSidebarBottomNavItem,
      newNodeBottomNavItem,
      appendTodayDailyBlockBottomNavItem,
      todayBottomNavItem,
      searchBottomNavItem,
      commandPaletteBottomNavItem,
    ])
  })
})

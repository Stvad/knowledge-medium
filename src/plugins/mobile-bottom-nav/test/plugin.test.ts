import { describe, expect, it } from 'vitest'
import { appMountsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  MobileBottomNav,
  mobileBottomNavMount,
  mobileBottomNavPlugin,
} from '../index.ts'

describe('mobileBottomNavPlugin', () => {
  it('contributes the mobile bottom navigation mount', () => {
    const runtime = resolveFacetRuntimeSync(mobileBottomNavPlugin)

    expect(runtime.read(appMountsFacet)).toEqual([mobileBottomNavMount])
    expect(mobileBottomNavMount.component).toBe(MobileBottomNav)
  })
})

import { appMountsFacet, type AppMountContribution } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { MobileBottomNav } from './MobileBottomNav.tsx'

export { MobileBottomNav } from './MobileBottomNav.tsx'

export const mobileBottomNavMount: AppMountContribution = {
  id: 'mobile-bottom-nav.mount',
  component: MobileBottomNav,
}

export const mobileBottomNavPlugin: AppExtension = [
  appMountsFacet.of(mobileBottomNavMount, {source: 'mobile-bottom-nav'}),
]

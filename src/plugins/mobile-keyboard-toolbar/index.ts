import { appMountsFacet, type AppMountContribution } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { MobileKeyboardToolbar } from './MobileKeyboardToolbar.tsx'

export { MobileKeyboardToolbar } from './MobileKeyboardToolbar.tsx'

export const mobileKeyboardToolbarMount: AppMountContribution = {
  id: 'mobile-keyboard-toolbar.mount',
  component: MobileKeyboardToolbar,
}

export const mobileKeyboardToolbarPlugin: AppExtension = [
  appMountsFacet.of(mobileKeyboardToolbarMount, {source: 'mobile-keyboard-toolbar'}),
]

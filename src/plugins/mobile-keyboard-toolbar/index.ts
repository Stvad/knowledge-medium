import { actionsFacet, appMountsFacet, type AppMountContribution } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { mobileKeyboardToolbarActions } from './actions.ts'
import { MobileKeyboardToolbar } from './MobileKeyboardToolbar.tsx'

export { MobileKeyboardToolbar } from './MobileKeyboardToolbar.tsx'
export { mobileKeyboardToolbarActions } from './actions.ts'

export const mobileKeyboardToolbarMount: AppMountContribution = {
  id: 'mobile-keyboard-toolbar.mount',
  component: MobileKeyboardToolbar,
}

export const mobileKeyboardToolbarPlugin: AppExtension = [
  mobileKeyboardToolbarActions.map(action => actionsFacet.of(action, {source: 'mobile-keyboard-toolbar'})),
  appMountsFacet.of(mobileKeyboardToolbarMount, {source: 'mobile-keyboard-toolbar'}),
]

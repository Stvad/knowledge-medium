import { actionsFacet, appMountsFacet, type AppMountContribution } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { mobileKeyboardToolbarActions } from './actions.ts'
import { mobileKeyboardToolbarItemsFacet } from './facet.ts'
import { defaultToolbarItems } from './defaultItems.ts'
import { MobileKeyboardToolbar } from './MobileKeyboardToolbar.tsx'

export { MobileKeyboardToolbar } from './MobileKeyboardToolbar.tsx'
export { mobileKeyboardToolbarActions } from './actions.ts'
export {
  EXIT_EDIT_ACTION_ID,
  mobileKeyboardToolbarItemsFacet,
  type MobileKeyboardToolbarItem,
} from './facet.ts'

export const mobileKeyboardToolbarMount: AppMountContribution = {
  id: 'mobile-keyboard-toolbar.mount',
  component: MobileKeyboardToolbar,
}

export const mobileKeyboardToolbarPlugin: AppExtension = systemToggle({
  id: 'system:mobile-keyboard-toolbar',
  name: 'Mobile keyboard toolbar',
  description: 'Editing toolbar that floats above the on-screen keyboard on mobile.',
}).of([
  mobileKeyboardToolbarActions.map(action => actionsFacet.of(action, {source: 'mobile-keyboard-toolbar'})),
  defaultToolbarItems.map(({item, precedence}) =>
    mobileKeyboardToolbarItemsFacet.of(item, {source: 'mobile-keyboard-toolbar', precedence}),
  ),
  appMountsFacet.of(mobileKeyboardToolbarMount, {source: 'mobile-keyboard-toolbar'}),
])

export default mobileKeyboardToolbarPlugin

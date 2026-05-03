import {
  actionsFacet,
  appMountsFacet,
  type AppMountContribution,
} from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.ts'
import { QuickFind } from './QuickFind.tsx'
import { toggleQuickFindEvent } from './events.ts'

export { QuickFind } from './QuickFind.tsx'
export { toggleQuickFindEvent } from './events.ts'

export const quickFindMount: AppMountContribution = {
  id: 'quick-find.dialog',
  component: QuickFind,
}

export const quickFindAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: 'quick_find',
  description: 'Find or create page or block',
  context: ActionContextTypes.GLOBAL,
  handler: () => {
    window.dispatchEvent(new CustomEvent(toggleQuickFindEvent))
  },
  defaultBinding: {
    keys: ['cmd+p', 'ctrl+p', 'cmd+shift+k', 'ctrl+shift+k'],
  },
}

export const quickFindPlugin: AppExtension = [
  appMountsFacet.of(quickFindMount, {source: 'quick-find'}),
  actionsFacet.of(quickFindAction, {source: 'quick-find'}),
]

import { headerItemsFacet, type HeaderItemContribution } from '@/extensions/core.js'
import type { AppExtension } from '@/extensions/facet.js'
import { systemToggle } from '@/extensions/togglable.js'
import { AccountHeaderItem } from './AccountHeaderItem.tsx'

export { AccountHeaderItem } from './AccountHeaderItem.tsx'

export const accountHeaderItem: HeaderItemContribution = {
  id: 'account-header.user-menu',
  region: 'end',
  component: AccountHeaderItem,
}

export const accountHeaderPlugin: AppExtension = systemToggle({
  id: 'system:account-header',
  name: 'Account header',
  description: 'User identity badge and logout entry in the header.',
}).of([
  headerItemsFacet.of(accountHeaderItem, {
    source: 'account-header',
    precedence: 50,
  }),
])

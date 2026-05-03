import { headerItemsFacet, type HeaderItemContribution } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { AccountHeaderItem } from './AccountHeaderItem.tsx'

export { AccountHeaderItem } from './AccountHeaderItem.tsx'

export const accountHeaderItem: HeaderItemContribution = {
  id: 'account-header.user-menu',
  region: 'end',
  component: AccountHeaderItem,
}

export const accountHeaderPlugin: AppExtension = [
  headerItemsFacet.of(accountHeaderItem, {
    source: 'account-header',
    precedence: 50,
  }),
]

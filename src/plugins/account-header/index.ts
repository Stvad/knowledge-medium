import { headerItemsFacet, type HeaderItemContribution } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { withSystemExtensionMetadata } from '@/extensions/togglable.ts'
import { AccountHeaderItem } from './AccountHeaderItem.tsx'

export { AccountHeaderItem } from './AccountHeaderItem.tsx'

export const accountHeaderItem: HeaderItemContribution = {
  id: 'account-header.user-menu',
  region: 'end',
  component: AccountHeaderItem,
}

export const accountHeaderPlugin: AppExtension = withSystemExtensionMetadata({
  name: 'Account header',
  description: 'User identity badge and logout entry in the header.',
}, [
  headerItemsFacet.of(accountHeaderItem, {
    source: 'account-header',
    precedence: 50,
  }),
])

import { headerItemsFacet, type HeaderItemContribution } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { withSystemExtensionMetadata } from '@/extensions/togglable.ts'
import { SyncStatusHeaderItem } from './SyncStatusHeaderItem.tsx'

export const syncStatusHeaderItem: HeaderItemContribution = {
  id: 'sync-status.header',
  region: 'end',
  component: SyncStatusHeaderItem,
}

export const syncStatusPlugin: AppExtension = withSystemExtensionMetadata({
  name: 'Sync status',
  description: 'Header indicator showing online / syncing / error state of the data sync.',
}, [
  headerItemsFacet.of(syncStatusHeaderItem, {
    source: 'sync-status',
    precedence: 40,
  }),
])

import { headerItemsFacet, type HeaderItemContribution } from '@/extensions/core.js'
import type { AppExtension } from '@/extensions/facet.js'
import { systemToggle } from '@/extensions/togglable.js'
import { SyncStatusHeaderItem } from './SyncStatusHeaderItem.tsx'

export const syncStatusHeaderItem: HeaderItemContribution = {
  id: 'sync-status.header',
  region: 'end',
  component: SyncStatusHeaderItem,
}

export const syncStatusPlugin: AppExtension = systemToggle({
  id: 'system:sync-status',
  name: 'Sync status',
  description: 'Header indicator showing online / syncing / error state of the data sync.',
}).of([
  headerItemsFacet.of(syncStatusHeaderItem, {
    source: 'sync-status',
    precedence: 40,
  }),
])

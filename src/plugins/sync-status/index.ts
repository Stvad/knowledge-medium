import { headerItemsFacet, type HeaderItemContribution } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { SyncStatusHeaderItem } from './SyncStatusHeaderItem.tsx'

export const syncStatusHeaderItem: HeaderItemContribution = {
  id: 'sync-status.header',
  region: 'end',
  component: SyncStatusHeaderItem,
}

export const syncStatusPlugin: AppExtension = [
  headerItemsFacet.of(syncStatusHeaderItem, {
    source: 'sync-status',
    precedence: 40,
  }),
]

import { headerItemsFacet, type HeaderItemContribution } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { SystemStatusHeaderItem } from './SystemStatusHeaderItem.tsx'
import { runDataIntegrityAuditActionContribution } from './auditAction.ts'

export const systemStatusHeaderItem: HeaderItemContribution = {
  id: 'system-status.header',
  region: 'end',
  component: SystemStatusHeaderItem,
}

// Formerly "sync-status": the chip started as a sync indicator but now
// aggregates the whole system's health (sync state + diagnostics seam: data
// integrity, storage persistence, app updates), so it's named for that.
export const systemStatusPlugin: AppExtension = systemToggle({
  id: 'system:system-status',
  name: 'System status',
  description: 'Header status indicator — sync state plus health signals (data integrity, storage, app updates).',
}).of([
  headerItemsFacet.of(systemStatusHeaderItem, {
    source: 'system-status',
    precedence: 40,
  }),
  // "Run data integrity audit" — command palette + the dropdown's Re-run button.
  runDataIntegrityAuditActionContribution,
])

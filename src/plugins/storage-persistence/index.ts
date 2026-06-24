import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { diagnosticsFacet } from '@/plugins/diagnostics/facet.js'
import { persistenceDiagnosticSource } from './persistenceStatus.ts'
import { requestPersistenceActionContribution } from './requestAction.ts'

export { REQUEST_PERSISTENCE_ACTION_ID } from './persistenceStatus.ts'

/** Surfaces an ambient reminder (via the diagnostics seam → status chip) when
 *  the origin's local storage isn't persistent, with a one-tap "Protect"
 *  request. The boot-time silent attempt lives in src/requestPersistentStorage.ts;
 *  this plugin is the contextual, user-initiated path. */
export const storagePersistencePlugin: AppExtension = systemToggle({
  id: 'system:storage-persistence',
  name: 'Storage persistence',
  description:
    'Reminds you when local data can be evicted under storage pressure and offers a one-tap request to make it persistent.',
}).of([
  diagnosticsFacet.of(persistenceDiagnosticSource, { source: 'storage-persistence' }),
  requestPersistenceActionContribution,
])

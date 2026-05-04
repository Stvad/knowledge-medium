import { kernelDataExtension } from '@/data/kernelDataExtension.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { backlinksDataExtension } from '@/plugins/backlinks/dataExtension.ts'
import { groupedBacklinksDataExtension } from '@/plugins/grouped-backlinks/dataExtension.ts'

/** Static data facets that must be available before the React app runtime
 *  resolves. Keep this list UI-free so repo bootstrap can install plugin
 *  data ownership without importing component trees. */
export const staticDataExtensions: AppExtension[] = [
  kernelDataExtension,
  backlinksDataExtension,
  groupedBacklinksDataExtension,
]

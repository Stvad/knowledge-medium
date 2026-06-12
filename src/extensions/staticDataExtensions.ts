import { kernelDataExtension } from '@/data/kernelDataExtension.js'
import type { AppExtension } from '@/facets/facet.js'
import { aliasDataExtension } from '@/plugins/alias/dataExtension.js'
import { backlinksDataExtension } from '@/plugins/backlinks/dataExtension.js'
import { dailyNotesDataExtension } from '@/plugins/daily-notes/dataExtension.js'
import { findReplaceDataExtension } from '@/plugins/find-replace/dataExtension.js'
import { groupedBacklinksDataExtension } from '@/plugins/grouped-backlinks/dataExtension.js'
import { referencesDataExtension } from '@/plugins/references/dataExtension.js'
import { srsReschedulingDataExtension } from '@/plugins/srs-rescheduling/dataExtension.js'
import { todoDataExtension } from '@/plugins/todo/dataExtension.js'

/** Static data facets that must be available before the React app runtime
 *  resolves. Keep this list UI-free so repo bootstrap can install plugin
 *  data ownership without importing component trees. */
export const staticDataExtensions: AppExtension[] = [
  kernelDataExtension,
  dailyNotesDataExtension,
  findReplaceDataExtension,
  referencesDataExtension,
  aliasDataExtension,
  backlinksDataExtension,
  groupedBacklinksDataExtension,
  srsReschedulingDataExtension,
  todoDataExtension,
]

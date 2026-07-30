import { kernelDataExtension } from '@/data/kernelDataExtension.js'
import type { AppExtension } from '@/facets/facet.js'
import { agentDispatchCompanionDataExtension } from '@/plugins/agent-dispatch-companion/dataExtension.js'
import { agentRuntimeDataExtension } from '@/plugins/agent-runtime/dataExtension.js'
import { aliasDataExtension } from '@/plugins/alias/dataExtension.js'
import { backlinksDataExtension } from '@/plugins/backlinks/dataExtension.js'
import { characterCounterDataExtension } from '@/plugins/character-counter/dataExtension.js'
import { dailyNotesDataExtension } from '@/plugins/daily-notes/dataExtension.js'
import { findReplaceDataExtension } from '@/plugins/find-replace/dataExtension.js'
import { geoDataExtension } from '@/plugins/geo/dataExtension.js'
import { groupedBacklinksDataExtension } from '@/plugins/grouped-backlinks/dataExtension.js'
import {
  referencesDataExtension,
  referencesRenameDataExtension,
} from '@/plugins/references/dataExtension.js'
import { srsReschedulingDataExtension } from '@/plugins/srs-rescheduling/dataExtension.js'
import { todoDataExtension } from '@/plugins/todo/dataExtension.js'

/** Static data facets that must be available before the React app runtime
 *  resolves. Keep this list UI-free so repo bootstrap can install plugin
 *  data ownership without importing component trees.
 *
 *  This is the registry the onboarding tutorial seeds against at bootstrap
 *  (before the app runtime is applied): it tags demo blocks with the todo /
 *  char-counter / srs / place / map types, so those plugins' data extensions
 *  must be here. */
export const staticDataExtensions: AppExtension[] = [
  kernelDataExtension,
  dailyNotesDataExtension,
  findReplaceDataExtension,
  referencesDataExtension,
  aliasDataExtension,
  // MUST stay after `aliasDataExtension`: same-tx processors run in facet
  // insertion order, and the rename rewriter reacts to the alias diff that
  // `alias.sync` writes when a page's title is edited. Registered ahead of
  // it, it would see no diff and never fire. See `renameProcessor.ts`.
  referencesRenameDataExtension,
  backlinksDataExtension,
  groupedBacklinksDataExtension,
  srsReschedulingDataExtension,
  todoDataExtension,
  characterCounterDataExtension,
  geoDataExtension,
  agentDispatchCompanionDataExtension,
  agentRuntimeDataExtension,
]

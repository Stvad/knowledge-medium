/**
 * Properties-as-blocks migration plugin.
 *
 * Contributes the palette command that runs the one-time cell → children pass.
 * Deliberately its own plugin rather than a line in db-maintenance: this is a
 * data migration with a runbook, not routine upkeep, and the flip that follows
 * it will live here too.
 */
import type { Repo } from '@/data/repo'
import type { AppExtension } from '@/facets/facet.js'
import { actionsFacet } from '@/extensions/core.js'
import { dialogAppMountExtension } from '@/extensions/dialogAppMount.js'
import { systemToggle } from '@/facets/togglable.js'
import { migratePropertiesToBlocksAction } from './action.ts'

export const propertiesMigrationPlugin = ({repo}: {repo: Repo}): AppExtension =>
  systemToggle({
    id: 'system:properties-migration',
    name: 'Properties migration',
    description:
      'Adds the one-time command that stores block properties as child blocks. ' +
      'Run it on a single device; the others receive the result through sync.',
  }).of([
    actionsFacet.of(migratePropertiesToBlocksAction({repo}), {source: 'properties-migration'}),
    dialogAppMountExtension,
  ])

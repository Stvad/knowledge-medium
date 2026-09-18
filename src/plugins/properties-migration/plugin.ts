/**
 * Properties-as-blocks migration plugin.
 *
 * TWO boundaries, and the split is the point. The COMMAND is ordinary upkeep a
 * user may hide and safe mode may prune. The GATE is not: it is the only thing
 * telling every device to wait while the graph is converted, and it holds the
 * undo pause that keeps a replay off rows the pass has rewritten. Pruning that
 * leaves the app fully writable, with no dialog and no pause, during exactly
 * the event it exists for — and safe mode is a URL any user can reach.
 *
 * Deliberately its own plugin rather than a line in db-maintenance: this is a
 * data migration with a runbook, not routine upkeep, and the flip that follows
 * it will live here too.
 */
import type { Repo } from '@/data/repo'
import type { AppExtension } from '@/facets/facet.js'
import { actionsFacet, appMountsFacet } from '@/extensions/core.js'
import { dialogAppMountExtension } from '@/extensions/dialogAppMount.js'
import { systemToggle } from '@/facets/togglable.js'
import { migratePropertiesToBlocksAction } from './action.ts'
import { MigrationGate } from './MigrationGate.tsx'

const migrationGate: AppExtension = systemToggle({
  id: 'system:properties-migration-gate',
  name: 'Properties migration gate',
  description:
    'Blocks a workspace while its properties are being converted to blocks, on every ' +
    'device. Kept enabled in safe mode: without it the app accepts edits, and undo, ' +
    'during a migration that is rewriting the same rows.',
  essential: true,
}).of([
  appMountsFacet.of(
    {id: 'properties-migration.gate', component: MigrationGate},
    {source: 'properties-migration'},
  ),
  dialogAppMountExtension,
])

export const propertiesMigrationPlugin = ({repo}: {repo: Repo}): AppExtension => [
  systemToggle({
    id: 'system:properties-migration',
    name: 'Properties migration',
    description:
      'Adds the one-time command that stores block properties as child blocks. ' +
      'Run it on a single device; the others receive the result through sync.',
  }).of([
    actionsFacet.of(migratePropertiesToBlocksAction({repo}), {source: 'properties-migration'}),
    dialogAppMountExtension,
  ]),
  migrationGate,
]

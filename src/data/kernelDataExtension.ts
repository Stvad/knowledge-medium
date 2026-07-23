/**
 * Kernel data-layer AppExtension — the single source of the kernel
 * mutators, queries, post-commit / same-tx processors, invalidation
 * rule, property definition seeds, and type seeds, expressed as facet
 * contributions. This is the ONLY kernel registration path (audit
 * B1(1)): the Repo constructor installs it as a kernel-only
 * `FacetRuntime` (`installKernelRuntime`, default true) so
 * `repo.mutate.<kernel>` / `repo.query.<kernel>` work immediately, and
 * every later `repo.setFacetRuntime(runtime)` REPLACES that install with
 * the merged kernel + plugin registry — so this extension must be
 * present in every runtime (it is, via `staticDataExtensions`) to keep
 * the kernel dispatch surfaces working after a swap.
 *
 * Property definitions: the kernel declarations live in
 * `data/properties.ts`; this extension contributes them through
 * `definitionSeedsFacet`. The workspace-bound registry synthesizes behavior
 * and durable identities from the declarations before their blocks exist.
 *
 * Also registers the default `searchSourcesFacet` contribution
 * (`coreContentSearchSource`, id `core.content`) — core's own content
 * search, expressed as a facet contribution so plugins can add a merged,
 * ranked second search source (e.g. semantic search) alongside it. See
 * `src/utils/linkTargetAutocomplete.ts` for the merge point.
 *
 * No facet sources beyond the data layer here — UI facets
 * (renderers, actions, contexts) live in their own extensions.
 */

import {
  definitionBlockProjectorFacet,
  definitionSeedsFacet,
  invalidationRulesFacet,
  mutatorsFacet,
  postCommitProcessorsFacet,
  queriesFacet,
  sameTxProcessorsFacet,
  searchSourcesFacet,
  systemPagesFacet,
  typeSeedsFacet,
  valuePresetCoresFacet,
} from './facets'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { getOrCreateTypesPage } from '@/data/typesPage'
import { getOrCreateRecentsPage } from '@/data/recentsPage'
import { KERNEL_MUTATORS } from './mutators'
import { KERNEL_PROCESSORS } from './internals/kernelProcessors'
import { KERNEL_SAME_TX_PROCESSORS } from './internals/normalizeReferencesProcessor'
import { KERNEL_QUERIES } from './internals/kernelQueries'
import { kernelInvalidationRule } from './internals/kernelInvalidation'
import { KERNEL_PROPERTY_SEEDS } from '@/data/properties'
import { KERNEL_TYPE_CONTRIBUTIONS } from '@/data/blockTypes'
import { kernelValuePresetCores } from '@/data/kernelValuePresetCores'
import { userSchemasProjector } from '@/data/userSchemasService'
import { userTypesProjector } from '@/data/userTypesService'
import { coreContentSearchSource } from '@/utils/linkTargetAutocomplete.js'
import type { AppExtension } from '@/facets/facet'
import { systemToggle } from '@/facets/togglable'

export const kernelDataExtension: AppExtension = systemToggle({
  id: 'system:kernel-data',
  name: 'Kernel data',
  description: 'Mutators, queries, post-commit processors, and invalidation rules the data layer requires.',
  essential: true,
}).of([
  KERNEL_MUTATORS.map(m => mutatorsFacet.of(m, {source: 'kernel'})),
  KERNEL_PROCESSORS.map(p => postCommitProcessorsFacet.of(p, {source: 'kernel'})),
  KERNEL_SAME_TX_PROCESSORS.map(p => sameTxProcessorsFacet.of(p, {source: 'kernel'})),
  KERNEL_QUERIES.map(q => queriesFacet.of(q, {source: 'kernel'})),
  searchSourcesFacet.of(coreContentSearchSource, {source: 'kernel'}),
  KERNEL_PROPERTY_SEEDS.map(seed => definitionSeedsFacet.of(seed, {source: 'kernel'})),
  // C4a: kernel types are code seeds now — contributed to `typeSeedsFacet` (not
  // the static `typesFacet`) so the materializer mints their backing blocks and
  // the type-definition registry synthesizes them into `repo.types`.
  KERNEL_TYPE_CONTRIBUTIONS.map(t => typeSeedsFacet.of(t, {source: 'kernel'})),
  kernelValuePresetCores.map(core => valuePresetCoresFacet.of(core, {source: 'kernel'})),
  invalidationRulesFacet.of(kernelInvalidationRule, {source: 'kernel'}),
  // Kernel singleton pages, materialised eagerly at workspace bootstrap via
  // `Repo.ensureSystemPages` (before the landing/seed) so wiki-links to their
  // reserved aliases resolve to the canonical page instead of auto-creating a
  // rival (alias.collision). Each get-or-create is idempotent + deterministic-id.
  systemPagesFacet.of({id: 'kernel:properties', ensure: getOrCreatePropertiesPage}, {source: 'kernel'}),
  systemPagesFacet.of({id: 'kernel:types', ensure: getOrCreateTypesPage}, {source: 'kernel'}),
  systemPagesFacet.of({id: 'kernel:recents', ensure: getOrCreateRecentsPage}, {source: 'kernel'}),
  // Definition-block projectors (issue #90): user-defined property
  // schemas and block types mirror into their facets' user-data buckets
  // through the shared `ProjectorRuntime`. Registered schemas-before-
  // types so the dependency order is also the registration order; the
  // type projector additionally declares `dependsOn: ['user-schemas']`.
  definitionBlockProjectorFacet.of(userSchemasProjector, {source: 'kernel'}),
  definitionBlockProjectorFacet.of(userTypesProjector, {source: 'kernel'}),
])

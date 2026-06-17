/**
 * Kernel data-layer AppExtension — the single source of the kernel
 * mutators, queries, post-commit / same-tx processors, invalidation
 * rule, property schemas, and type contributions, expressed as facet
 * contributions. This is the ONLY kernel registration path (audit
 * B1(1)): the Repo constructor installs it as a kernel-only
 * `FacetRuntime` (`installKernelRuntime`, default true) so
 * `repo.mutate.<kernel>` / `repo.query.<kernel>` work immediately, and
 * every later `repo.setFacetRuntime(runtime)` REPLACES that install with
 * the merged kernel + plugin registry — so this extension must be
 * present in every runtime (it is, via `staticDataExtensions`) to keep
 * the kernel dispatch surfaces working after a swap.
 *
 * Property schemas: the kernel descriptors live in `data/properties.ts`
 * (plain consts); this extension surfaces them through
 * `propertySchemasFacet` so non-React surfaces (the property panel's
 * schema lookup, future CLI / server-side audit) and plugin authors can
 * resolve names through the same registry that plugin schemas register
 * into.
 *
 * No facet sources beyond the data layer here — UI facets
 * (renderers, actions, contexts) live in their own extensions.
 */

import {
  invalidationRulesFacet,
  mutatorsFacet,
  postCommitProcessorsFacet,
  propertySchemasFacet,
  queriesFacet,
  sameTxProcessorsFacet,
  typesFacet,
} from './facets'
import { KERNEL_MUTATORS } from './mutators'
import { KERNEL_PROCESSORS } from './internals/kernelProcessors'
import { KERNEL_SAME_TX_PROCESSORS } from './internals/normalizeReferencesProcessor'
import { KERNEL_QUERIES } from './internals/kernelQueries'
import { kernelInvalidationRule } from './internals/kernelInvalidation'
import { KERNEL_PROPERTY_SCHEMAS } from '@/data/properties'
import { KERNEL_TYPE_CONTRIBUTIONS } from '@/data/blockTypes'
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
  KERNEL_PROPERTY_SCHEMAS.map(s => propertySchemasFacet.of(s, {source: 'kernel'})),
  KERNEL_TYPE_CONTRIBUTIONS.map(t => typesFacet.of(t, {source: 'kernel'})),
  invalidationRulesFacet.of(kernelInvalidationRule, {source: 'kernel'}),
])

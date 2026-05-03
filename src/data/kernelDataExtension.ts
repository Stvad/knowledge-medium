/**
 * Kernel data-layer AppExtension — wraps the kernel mutators,
 * post-commit processors, and property schemas as facet contributions
 * so the FacetRuntime carries them. The Repo bootstraps with mutators
 * and processors registered directly (constructor
 * `registerKernelMutators` / `registerKernelProcessors`), but
 * `repo.setFacetRuntime(runtime)` REPLACES the registries, so the
 * runtime's mutator / processor facets must include the kernel
 * contributions to keep `repo.mutate.<kernel>` working after that
 * call. AppRuntimeProvider's baseExtensions includes this one
 * alongside plugin extensions before resolving the runtime.
 *
 * Property schemas (Phase 3 — chunk A): the kernel descriptors live
 * in `data/properties.ts` + `data/internals/coreProperties.ts` and are
 * exported as plain consts; this extension surfaces them through
 * `propertySchemasFacet` so non-React surfaces (the property panel's
 * schema lookup, future CLI / server-side audit) and plugin authors
 * can resolve names through the same registry that plugin schemas
 * register into.
 *
 * Queries (Phase 4 — chunk B): KERNEL_QUERIES are facet-contributed
 * here so `repo.setFacetRuntime(runtime)` includes them alongside
 * plugin queries. Repo also registers them at construction time
 * (RepoOptions.registerKernelQueries, default true) so `repo.query.X`
 * works pre-Stage-1 in the same way `repo.mutate.X` does — the
 * setFacetRuntime call replaces the registry with the merged
 * kernel + plugin set, so the kernel queries must be in the runtime
 * to keep `repo.query.<kernel>` working after that call.
 *
 * No facet sources beyond the data layer here — UI facets
 * (renderers, actions, contexts) live in their own extensions.
 */

import { mutatorsFacet, postCommitProcessorsFacet, propertySchemasFacet, queriesFacet } from './facets'
import { KERNEL_MUTATORS } from './internals/kernelMutators'
import { KERNEL_PROCESSORS } from './internals/parseReferencesProcessor'
import { KERNEL_QUERIES } from './internals/kernelQueries'
import { KERNEL_PROPERTY_SCHEMAS } from '@/data/properties'
import type { AppExtension } from '@/extensions/facet'

export const kernelDataExtension: AppExtension = [
  KERNEL_MUTATORS.map(m => mutatorsFacet.of(m, {source: 'kernel'})),
  KERNEL_PROCESSORS.map(p => postCommitProcessorsFacet.of(p, {source: 'kernel'})),
  KERNEL_QUERIES.map(q => queriesFacet.of(q, {source: 'kernel'})),
  KERNEL_PROPERTY_SCHEMAS.map(s => propertySchemasFacet.of(s, {source: 'kernel'})),
]

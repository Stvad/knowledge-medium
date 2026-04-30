/**
 * Kernel data-layer AppExtension — wraps the kernel mutators and
 * post-commit processors as facet contributions so the FacetRuntime
 * carries them. The Repo bootstraps with these registered directly
 * (constructor `registerKernelMutators` / `registerKernelProcessors`),
 * but `repo.setFacetRuntime(runtime)` REPLACES the registries, so the
 * runtime's mutator / processor facets must include the kernel
 * contributions to keep `repo.mutate.<kernel>` working after that
 * call. AppRuntimeProvider's baseExtensions includes this one
 * alongside plugin extensions before resolving the runtime.
 *
 * No facet sources beyond the data layer here — UI facets
 * (renderers, actions, contexts) live in their own extensions.
 */

import { mutatorsFacet, postCommitProcessorsFacet } from './facets'
import { KERNEL_MUTATORS } from './kernelMutators'
import { KERNEL_PROCESSORS } from './parseReferencesProcessor'
import type { AppExtension } from '@/extensions/facet'

export const kernelDataExtension: AppExtension = [
  KERNEL_MUTATORS.map(m => mutatorsFacet.of(m, {source: 'kernel'})),
  KERNEL_PROCESSORS.map(p => postCommitProcessorsFacet.of(p, {source: 'kernel'})),
]

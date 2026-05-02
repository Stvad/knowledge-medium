/**
 * Data-layer facets — the bridge between the kernel + plugin
 * contributions and the `Repo` lifecycle (spec §6, §8).
 *
 * Stage 1.4 ships `mutatorsFacet` only. The remaining four facets
 * (`queriesFacet`, `propertySchemasFacet`, `propertyUiFacet`,
 * `postCommitProcessorsFacet`) land in stages 1.5+ as the matching
 * machinery comes online.
 */

import { defineFacet } from '@/extensions/facet'
import type {
  AnyMutator,
  AnyPostCommitProcessor,
  AnyPropertySchema,
  AnyPropertyUiContribution,
  AnyQuery,
} from '@/data/api'

/** Key the registry by `Mutator.name`; duplicates log a warning and
 *  last-wins (per §6 convention). Mutators with heterogeneous
 *  Args/Result types share the registry slot via `AnyMutator` (variance
 *  escape); call-site dispatch (`repo.mutate.X`, `tx.run(m, args)`)
 *  recovers precise types via the `MutatorRegistry` augmentation. */
export const mutatorsFacet = defineFacet<AnyMutator, ReadonlyMap<string, AnyMutator>>({
  id: 'data.mutators',
  combine: (values) => {
    const out = new Map<string, AnyMutator>()
    for (const m of values) {
      if (out.has(m.name)) {
        console.warn(
          `[mutatorsFacet] duplicate registration for "${m.name}"; last-wins per facet convention`,
        )
      }
      out.set(m.name, m)
    }
    return out
  },
  empty: () => new Map(),
})

/** Future facets — declared empty for now so plugin authors can
 *  reference them at compile time without runtime breakage when no
 *  contributions exist. Wired up in stages 1.5+. */

export const queriesFacet = defineFacet<AnyQuery, ReadonlyMap<string, AnyQuery>>({
  id: 'data.queries',
  combine: (values) => {
    const out = new Map<string, AnyQuery>()
    for (const q of values) {
      if (out.has(q.name)) {
        console.warn(
          `[queriesFacet] duplicate registration for "${q.name}"; last-wins per facet convention`,
        )
      }
      out.set(q.name, q)
    }
    return out
  },
  empty: () => new Map(),
})

export const propertySchemasFacet = defineFacet<AnyPropertySchema, ReadonlyMap<string, AnyPropertySchema>>({
  id: 'data.propertySchemas',
  combine: (values) => {
    const out = new Map<string, AnyPropertySchema>()
    for (const s of values) {
      if (out.has(s.name)) {
        console.warn(
          `[propertySchemasFacet] duplicate registration for "${s.name}"; last-wins per facet convention`,
        )
      }
      out.set(s.name, s)
    }
    return out
  },
  empty: () => new Map(),
})

export const propertyUiFacet = defineFacet<AnyPropertyUiContribution, ReadonlyMap<string, AnyPropertyUiContribution>>({
  id: 'data.propertyUi',
  combine: (values) => {
    const out = new Map<string, AnyPropertyUiContribution>()
    for (const c of values) {
      if (out.has(c.name)) {
        console.warn(
          `[propertyUiFacet] duplicate registration for "${c.name}"; last-wins per facet convention`,
        )
      }
      out.set(c.name, c)
    }
    return out
  },
  empty: () => new Map(),
})

export const postCommitProcessorsFacet = defineFacet<AnyPostCommitProcessor, ReadonlyMap<string, AnyPostCommitProcessor>>({
  id: 'data.postCommitProcessors',
  combine: (values) => {
    const out = new Map<string, AnyPostCommitProcessor>()
    for (const p of values) {
      if (out.has(p.name)) {
        console.warn(
          `[postCommitProcessorsFacet] duplicate registration for "${p.name}"; last-wins per facet convention`,
        )
      }
      out.set(p.name, p)
    }
    return out
  },
  empty: () => new Map(),
})

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
  AnyPropertyEditorFallbackContribution,
  AnyPropertySchema,
  AnyPropertyUiContribution,
  AnyQuery,
  TypeContribution,
} from '@/data/api'
import type { InvalidationRule } from './invalidation.ts'

export interface LocalSchemaDb {
  execute: (sql: string) => Promise<unknown>
  getOptional: <T>(sql: string) => Promise<T | null>
}

export interface LocalSchemaBackfill {
  id: string
  run: (db: LocalSchemaDb) => Promise<void>
}

export interface LocalSchemaContribution {
  id: string
  statements?: readonly string[]
  triggerNames?: readonly string[]
  backfills?: readonly LocalSchemaBackfill[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

const isLocalSchemaBackfill = (value: unknown): value is LocalSchemaBackfill =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.run === 'function'

const isLocalSchemaContribution = (value: unknown): value is LocalSchemaContribution =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  (value.statements === undefined || isStringArray(value.statements)) &&
  (value.triggerNames === undefined || isStringArray(value.triggerNames)) &&
  (
    value.backfills === undefined ||
    (Array.isArray(value.backfills) && value.backfills.every(isLocalSchemaBackfill))
  )

const isInvalidationRule = (value: unknown): value is InvalidationRule =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  (
    value.collectFromSnapshots === undefined ||
    typeof value.collectFromSnapshots === 'function'
  ) &&
  (
    value.collectFromRowEvent === undefined ||
    typeof value.collectFromRowEvent === 'function'
  )

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

export const typesFacet = defineFacet<TypeContribution, ReadonlyMap<string, TypeContribution>>({
  id: 'data.types',
  combine: (values) => {
    const out = new Map<string, TypeContribution>()
    for (const t of values) {
      if (out.has(t.id)) {
        console.warn(
          `[typesFacet] duplicate registration for "${t.id}"; last-wins per facet convention`,
        )
      }
      out.set(t.id, t)
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

export const propertyEditorFallbackFacet = defineFacet<
  AnyPropertyEditorFallbackContribution,
  readonly AnyPropertyEditorFallbackContribution[]
>({
  id: 'data.propertyEditorFallbacks',
  combine: values => [...values].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
  empty: () => [],
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

export const localSchemaFacet = defineFacet<LocalSchemaContribution, readonly LocalSchemaContribution[]>({
  id: 'data.localSchema',
  validate: isLocalSchemaContribution,
})

export const invalidationRulesFacet = defineFacet<InvalidationRule, readonly InvalidationRule[]>({
  id: 'data.invalidationRules',
  validate: isInvalidationRule,
})

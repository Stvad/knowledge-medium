import type {AnyPropertySchema, TypeContribution} from './api'

interface TypePropertyGroup {
  readonly typeId: string
  readonly contribution: TypeContribution
  readonly fields: readonly {
    readonly declaration: AnyPropertySchema
    readonly schema: AnyPropertySchema
  }[]
}

/** Shared fields remain in each group so callers can deduplicate after their own eligibility checks. */
export function* typePropertyGroups(
  typeIds: readonly string[],
  types: ReadonlyMap<string, TypeContribution>,
  schemas: ReadonlyMap<string, AnyPropertySchema>,
): IterableIterator<TypePropertyGroup> {
  const seen = new Set<string>()
  for (const typeId of typeIds) {
    if (seen.has(typeId)) continue
    seen.add(typeId)
    const contribution = types.get(typeId)
    if (!contribution) continue
    const fields = (contribution.properties ?? []).flatMap(declaration => {
      const schema = schemas.get(declaration.name)
      return schema ? [{declaration, schema}] : []
    })
    yield {typeId, contribution, fields}
  }
}

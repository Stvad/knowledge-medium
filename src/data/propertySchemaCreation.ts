import type {AnyPropertySchema, Tx} from './api'
import type {Repo} from './repo'

export interface PropertySchemaChoice {
  /** A schema selected from the registry. */
  adopted?: AnyPropertySchema
  name: string
  presetId: string
}

/** Adopt an existing definition; the callback joins creation in the definition's transaction. */
export async function adoptOrCreatePropertySchema(
  repo: Repo,
  choice: PropertySchemaChoice,
  onCreate?: (tx: Tx, fieldId: string) => Promise<void>,
) {
  const name = choice.name.trim()
  const existing = choice.adopted ?? repo.propertySchemas.get(name)
  if (existing) return {kind: 'adopted' as const, schema: existing}
  return {kind: 'created' as const, schema: await repo.userSchemas.addSchema({name, presetId: choice.presetId}, onCreate)}
}

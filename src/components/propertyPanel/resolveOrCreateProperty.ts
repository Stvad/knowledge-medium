import type {AnyPropertySchema} from '@/data/api'
import type {Repo} from '@/data/repo'
import {showError} from '@/utils/toast'
import type {AddPropertyArgs} from './PropertyPicker'

export const resolveOrCreateProperty = async (
  repo: Repo,
  args: AddPropertyArgs,
  schemas: ReadonlyMap<string, AnyPropertySchema> = repo.propertySchemas,
): Promise<AnyPropertySchema | undefined> => {
  const name = args.name.trim()
  if (!name) return undefined
  const existing = args.adopted ?? schemas.get(name)
  if (existing) return existing
  try {
    return await repo.userSchemas.addSchema({name, presetId: args.presetId})
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error))
    return undefined
  }
}

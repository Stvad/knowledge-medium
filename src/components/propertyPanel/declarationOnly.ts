import type {PropertyDefinitionMetadata} from '@/data/propertyDefinitionMetadata'
import type {PropertyDefinitionRegistrySnapshot} from '@/data/propertyDefinitionRegistry'

/** Selected definition metadata whose behavior is unavailable on this client. */
export const declarationOnlyDefinitionForName = (
  name: string,
  definitions: PropertyDefinitionRegistrySnapshot | null,
): PropertyDefinitionMetadata | undefined => {
  if (definitions?.schemas.has(name)) return undefined
  return definitions?.definitionsByName.get(name)?.[0]
}

export const declarationOnlyStatusText = (
  definition: PropertyDefinitionMetadata,
): string => {
  if (definition.origin.startsWith('plugin:')) {
    const owner = definition.origin.slice('plugin:'.length).split(':').at(-1)
      ?? definition.origin.slice('plugin:'.length)
    return `Provided by ${owner} — not installed/disabled`
  }
  if (definition.origin === 'kernel') return 'Kernel definition — behavior unavailable'
  return 'User-created definition — behavior unavailable'
}

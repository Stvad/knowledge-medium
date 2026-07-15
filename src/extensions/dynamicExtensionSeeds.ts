import {
  isPropertySeedDeclaration,
  type AnyPropertySeedDeclaration,
} from '@/data/propertySeeds.js'

const DYNAMIC_EXTENSION_SEED_OWNER = '@extension'
const DYNAMIC_EXTENSION_PROPERTY_PREFIX = `${DYNAMIC_EXTENSION_SEED_OWNER}/property/`

/**
 * Build a property seed key for code stored in an extension block.
 *
 * Dynamic source cannot know its containing block id while the module is being
 * authored. The loader replaces this reserved owner with the encoded block id
 * before the contribution reaches the runtime, preserving one durable identity
 * per installed extension block even when two blocks contain identical source.
 */
export const extensionPropertySeedKey = (key: string): string => {
  if (key.length === 0 || key.includes('/')) {
    throw new Error('[extensionPropertySeedKey] key must be a non-empty path segment')
  }
  return `${DYNAMIC_EXTENSION_PROPERTY_PREFIX}${key}`
}

const boundOwners = new WeakMap<AnyPropertySeedDeclaration, string>()

/** Loader-only: bind a declaration's reserved dynamic owner to its block. */
export const bindExtensionPropertySeed = (
  value: unknown,
  blockId: string,
): AnyPropertySeedDeclaration => {
  if (!isPropertySeedDeclaration(value)) {
    throw new Error('Dynamic definition seed contribution is malformed')
  }

  const alreadyBoundTo = boundOwners.get(value)
  if (alreadyBoundTo !== undefined) {
    if (alreadyBoundTo !== blockId) {
      throw new Error(
        'Dynamic definition seed declaration was reused across extension blocks',
      )
    }
    return value
  }

  if (!value.seedKey.startsWith(DYNAMIC_EXTENSION_PROPERTY_PREFIX)) {
    throw new Error(
      'Dynamic property seeds must use extensionPropertySeedKey(key)',
    )
  }

  const owner = encodeURIComponent(blockId)
  if (owner.length === 0) {
    throw new Error('Dynamic extension block id must be non-empty')
  }
  const key = value.seedKey.slice(DYNAMIC_EXTENSION_PROPERTY_PREFIX.length)
  ;(value as {seedKey: string}).seedKey = `${owner}/property/${key}`
  boundOwners.set(value, blockId)
  return value
}

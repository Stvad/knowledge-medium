import {
  isPropertySeedDeclaration,
  type AnyPropertySeedDeclaration,
} from '@/data/propertySeeds.js'
import {
  isPropertyEditorOverride,
  type AnyPropertyEditorOverride,
} from '@/data/api'
import {
  isTypeSeedDeclaration,
  type TypeSeedDeclaration,
} from '@/data/typeSeeds.js'

const DYNAMIC_EXTENSION_SEED_OWNER = '@extension'
const DYNAMIC_EXTENSION_PROPERTY_PREFIX = `${DYNAMIC_EXTENSION_SEED_OWNER}/property/`
const DYNAMIC_EXTENSION_TYPE_PREFIX = `${DYNAMIC_EXTENSION_SEED_OWNER}/type/`

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

/** Rewrite a reserved dynamic seedKey (`@extension/<segment>/<key>`) to its
 *  block-scoped form (`<encodeURIComponent(blockId)>/<segment>/<key>`).
 *  `segment` selects the namespace — `property` or the disjoint `type` (see
 *  `isPropertySeedKey` / `isTypeSeedKey`). Callers guarantee the matching
 *  reserved prefix is present before calling. */
const bindReservedSeedKey = (
  seedKey: string,
  blockId: string,
  segment: 'property' | 'type',
): string => {
  const owner = encodeURIComponent(blockId)
  if (owner.length === 0) {
    throw new Error('Dynamic extension block id must be non-empty')
  }
  const key = seedKey.slice(`${DYNAMIC_EXTENSION_SEED_OWNER}/${segment}/`.length)
  return `${owner}/${segment}/${key}`
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

  ;(value as {seedKey: string}).seedKey = bindReservedSeedKey(value.seedKey, blockId, 'property')
  boundOwners.set(value, blockId)
  return value
}

/**
 * Loader-only: bind a dynamic editor override to its block so its `seedKey`
 * matches the block-bound key its property seed received. Returns a fresh
 * bound override (the source object is shared across installs; unlike a seed
 * declaration it is not mutated in place). An override targeting a
 * non-dynamic seed (a kernel/other-plugin seedKey without the reserved
 * prefix) passes through unchanged, so a dynamic extension can still override
 * another owner's editor.
 */
export const bindExtensionPropertyOverride = (
  value: unknown,
  blockId: string,
): AnyPropertyEditorOverride => {
  if (!isPropertyEditorOverride(value)) {
    throw new Error('Dynamic property editor override contribution is malformed')
  }
  if (!value.seedKey.startsWith(DYNAMIC_EXTENSION_PROPERTY_PREFIX)) {
    return value
  }
  return {...value, seedKey: bindReservedSeedKey(value.seedKey, blockId, 'property')}
}

/**
 * Build a type seed key for code stored in an extension block — the type-side
 * analog of `extensionPropertySeedKey`. Same reserved-owner mechanism: the
 * loader rebinds the reserved owner to the encoded block id (see
 * `bindExtensionTypeSeed`) before the contribution reaches the runtime, so each
 * installed extension block gets one durable per-block type identity even when
 * two blocks contain identical source. This is what gives a dynamic extension's
 * `seedType` full parity with a static plugin's: a per-workspace materialized
 * backing block, keyed off a block-scoped seedKey.
 */
export const extensionTypeSeedKey = (key: string): string => {
  if (key.length === 0 || key.includes('/')) {
    throw new Error('[extensionTypeSeedKey] key must be a non-empty path segment')
  }
  return `${DYNAMIC_EXTENSION_TYPE_PREFIX}${key}`
}

const boundTypeOwners = new WeakMap<TypeSeedDeclaration, string>()

/** Loader-only: bind a type-seed declaration's reserved dynamic owner to its
 *  block (mirrors `bindExtensionPropertySeed`). Mutates `seedKey` in place so
 *  the block-scoped identity is what the runtime, registry, and materializer
 *  observe; a WeakMap guard makes re-binding idempotent and rejects reuse of one
 *  declaration object across two extension blocks (which would collapse two
 *  installs onto a single backing block). */
export const bindExtensionTypeSeed = (
  value: unknown,
  blockId: string,
): TypeSeedDeclaration => {
  if (!isTypeSeedDeclaration(value)) {
    throw new Error('Dynamic type seed contribution is malformed')
  }

  const alreadyBoundTo = boundTypeOwners.get(value)
  if (alreadyBoundTo !== undefined) {
    if (alreadyBoundTo !== blockId) {
      throw new Error(
        'Dynamic type seed declaration was reused across extension blocks',
      )
    }
    return value
  }

  if (!value.seedKey.startsWith(DYNAMIC_EXTENSION_TYPE_PREFIX)) {
    throw new Error('Dynamic type seeds must use extensionTypeSeedKey(key)')
  }

  ;(value as {seedKey: string}).seedKey = bindReservedSeedKey(value.seedKey, blockId, 'type')
  boundTypeOwners.set(value, blockId)
  return value
}

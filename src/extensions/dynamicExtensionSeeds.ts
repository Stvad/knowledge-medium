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
const reservedPrefixFor = (segment: 'property' | 'type'): string =>
  segment === 'property' ? DYNAMIC_EXTENSION_PROPERTY_PREFIX : DYNAMIC_EXTENSION_TYPE_PREFIX

const bindReservedSeedKey = (
  seedKey: string,
  blockId: string,
  segment: 'property' | 'type',
): string => {
  const owner = encodeURIComponent(blockId)
  if (owner.length === 0) {
    throw new Error('Dynamic extension block id must be non-empty')
  }
  const prefix = reservedPrefixFor(segment)
  // Callers already guard `startsWith(prefix)` before calling, so a mismatch
  // here is a segment/prefix wiring bug — fail loudly instead of silently
  // mis-slicing (the two reserved prefixes differ in length).
  if (!seedKey.startsWith(prefix)) {
    throw new Error(
      `[bindReservedSeedKey] ${JSON.stringify(seedKey)} does not carry the reserved ${segment} prefix`,
    )
  }
  return `${owner}/${segment}/${seedKey.slice(prefix.length)}`
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

/** A dynamic `seedType` may embed property seeds in its `properties`; their
 *  keys are persisted into the backing block's `block-type:properties` refs
 *  (see `canonicalTypeSeedProperties`). Those nested seeds carry the same
 *  reserved `@extension/property/<key>` owner and must be block-bound too —
 *  otherwise a ref to a definition block derived from the reserved key gets
 *  persisted, and that block never materializes (a dangling ref; a reserved
 *  key must never reach storage). Rebind each through the idempotent
 *  `bindExtensionPropertySeed` so it agrees with the same seed when it's ALSO
 *  contributed separately, in either contribution order. A reserved-keyed entry
 *  that isn't a well-formed property seed is rejected rather than silently
 *  persisting its reserved key.
 *
 *  Bind a full declaration that is reserved-keyed OR one this loader has ALREADY
 *  bound to some block. The second case is the reuse hazard: block A's bind mutates
 *  a shared declaration object's `seedKey` to `<blockA>/property/…`, so at block B
 *  the reserved prefix is gone — skipping it as a "cross-owner ref" would silently
 *  persist block B's type ref to block A's property. Routing it back through
 *  `bindExtensionPropertySeed` lets its WeakMap guard REJECT the cross-block reuse
 *  (throw), exactly as the top-level type/property binds do. A full declaration that
 *  is NEITHER reserved NOR previously bound is a genuine cross-owner reference (e.g.
 *  a kernel property) and stays a pure ref. */
const bindNestedDynamicPropertySeeds = (
  properties: ReadonlyArray<unknown>,
  blockId: string,
): void => {
  for (const prop of properties) {
    if (typeof prop !== 'object' || prop === null) continue
    const seedKey: unknown = (prop as {seedKey?: unknown}).seedKey
    const reserved = typeof seedKey === 'string' && seedKey.startsWith(DYNAMIC_EXTENSION_PROPERTY_PREFIX)
    if (!isPropertySeedDeclaration(prop)) {
      // A malformed entry still carrying a reserved key must be rejected (that key
      // would otherwise reach storage); anything else is a plain reference to leave.
      if (reserved) {
        throw new Error(
          'Dynamic type seed embeds a malformed reserved property seed in `properties`',
        )
      }
      continue
    }
    if (reserved || boundOwners.has(prop)) {
      bindExtensionPropertySeed(prop, blockId)
    }
  }
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
  if (value.properties !== undefined) {
    bindNestedDynamicPropertySeeds(value.properties, blockId)
  }
  boundTypeOwners.set(value, blockId)
  return value
}

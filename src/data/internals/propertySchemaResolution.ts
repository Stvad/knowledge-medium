import type {
  AnyPropertySchema,
  PropertyHandle,
  PropertySchema,
  PropertySchemaIdentityUnavailableReason,
  PropertySchemaResolution,
  ResolvedPropertySchema,
} from '@/data/api'
import {PropertySchemaIdentityError} from '@/data/api'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'
import type {PropertyDefinitionMetadata} from '@/data/propertyDefinitionMetadata'
import {propertySchemaOriginForSeedKey} from '@/data/propertyDefinitionMetadata'
import type {PropertyDefinitionRegistrySnapshot} from '@/data/propertyDefinitionRegistry'

export type PropertyBoundaryResolution<T> =
  | {readonly status: 'available'; readonly schema: PropertySchema<T>}
  | {
      readonly status: 'identity-unavailable'
      readonly reason: PropertySchemaIdentityUnavailableReason
    }

const isPropertyHandle = <T>(schema: PropertySchema<T>): schema is PropertyHandle<T> =>
  typeof (schema as Partial<PropertyHandle<T>>).seedKey === 'string'

export const isResolvedPropertySchema = <T>(
  schema: PropertySchema<T>,
): schema is ResolvedPropertySchema<T> => {
  const candidate = schema as Partial<ResolvedPropertySchema<T>>
  return typeof candidate.fieldId === 'string' && typeof candidate.workspaceId === 'string'
}

/** A resolver is created for an owning transaction/workspace registry
 * snapshot; callers supply only the definition handle or name, never a
 * workspace id. */
export interface PropertySchemaResolver {
  resolve<T>(handle: PropertyHandle<T>): PropertySchemaResolution<T>
  resolve(name: string): PropertySchemaResolution<unknown>
  resolveField(fieldId: string): PropertySchemaResolution<unknown>
  resolveBoundary<T>(schema: PropertySchema<T>): PropertyBoundaryResolution<T>
}

/** Resolve one projected definition to the schema the workspace selects for its
 * durable field id. Resolving by identity (not by the row's stored name) keeps
 * seed-provenanced definitions resolvable even when a stored property-schema:name
 * diverges from the code seed's declared name — seeds are non-renamable, so the
 * registry pins them to the declared name and the raw row name must not be used
 * as a lookup key. Unknown, shadowed, and cross-workspace fields return
 * undefined. */
export const resolveSelectedPropertyDefinition = (
  metadata: Pick<PropertyDefinitionMetadata, 'fieldId'>,
  resolver: PropertySchemaResolver,
): AnyPropertySchema | undefined => {
  const resolution = resolver.resolveField(metadata.fieldId)
  return resolution.status === 'resolved' ? resolution.schema : undefined
}

class IdentityUnavailablePropertySchemaResolver implements PropertySchemaResolver {
  resolve<T>(handle: PropertyHandle<T>): PropertySchemaResolution<T>
  resolve(name: string): PropertySchemaResolution<unknown>
  resolve<T>(schema: PropertyHandle<T> | string): PropertySchemaResolution<T> {
    void schema
    return {
      status: 'identity-unavailable',
      reason: 'registry-not-workspace-keyed',
    }
  }

  resolveField(fieldId: string): PropertySchemaResolution<unknown> {
    void fieldId
    return {status: 'identity-unavailable', reason: 'registry-not-workspace-keyed'}
  }

  resolveBoundary<T>(schema: PropertySchema<T>): PropertyBoundaryResolution<T> {
    void schema
    return {status: 'identity-unavailable', reason: 'registry-not-workspace-keyed'}
  }
}

/** Fail-closed form of the property-identity primitive. It cannot construct a
 * resolved schema; boundary sites consume a resolver bound to the target row's
 * workspace snapshot. */
export const unavailablePropertySchemaResolver: PropertySchemaResolver =
  new IdentityUnavailablePropertySchemaResolver()

/** Records each decode-fallback-wrapped schema against its strict pre-image, so
 *  the WRITE seam can recover the un-degraded codec. WeakMap: entries evaporate
 *  with the ephemeral per-resolution wrapper, and the wrapper is a fresh object
 *  per `withDecodeFallback` call so keys never collide. */
const strictSchemaByFallback = new WeakMap<
  PropertySchema<unknown>,
  PropertySchema<unknown>
>()

/** Wrap a schema so its codec's `decode` falls back to the schema default
 *  instead of throwing. Used for a PLUGIN handle read against a workspace whose
 *  faithful projection isn't loaded (the active workspace before it primes, or a
 *  genuinely foreign workspace): the stored value is almost always the plugin's
 *  own (decodes cleanly), but a rare pre-existing/synced user definition could
 *  shadow the name with a value the plugin's (strict) codec rejects — degrade
 *  that to the default rather than throw in a synchronous render. This is a
 *  READ affordance only: `encode` is unchanged, and the write seam
 *  (`requireWritablePropertySchema`) strips the fallback back to the strict
 *  codec, so a write never silently degrades a stored value it can't decode. */
const withDecodeFallback = <T>(schema: PropertySchema<T>): PropertySchema<T> => {
  const wrapped: PropertySchema<T> = {
    ...schema,
    codec: {
      ...schema.codec,
      decode: (value: unknown): T => {
        try {
          return schema.codec.decode(value)
        } catch {
          return schema.defaultValue
        }
      },
    },
  }
  strictSchemaByFallback.set(
    wrapped as PropertySchema<unknown>,
    schema as PropertySchema<unknown>,
  )
  return wrapped
}

/** The fallback resolver for a workspace with no faithful registry snapshot —
 * either the boot window (stage-0, or the active workspace before its projection
 * primes) or a genuinely foreign workspace (neither active nor the retained
 * immediately-previous one). In both, we can't consult the workspace's projected
 * definitions, so name-based lookups can't be trusted. But a code-owned seed
 * HANDLE is a workspace-independent identity — registered from the same code on
 * every device — so it still resolves: a KERNEL handle directly (unshadowable, no
 * user schema ever existed at its name), a PLUGIN handle via a decode fallback
 * (its name CAN collide with an unloaded user definition, so a shadow-incompatible
 * stored value degrades to the default instead of throwing). This is what lets
 * cross-workspace seed writes/reads work — type tagging, ref backfill, a plugin
 * seeding a note/asset in a non-active target workspace (daily-notes, attachments,
 * srs). `allowUnregisteredPlainSchemas` is the only boot-window/foreign
 * difference: the active workspace admits its ambient plain schemas; a foreign
 * workspace fails an unclaimed plain name closed (we can't confirm it's a winner
 * there). A name that collides with a seed declaration always fails closed. */
class HandleTrustingPropertySchemaResolver
  extends IdentityUnavailablePropertySchemaResolver {
  constructor(
    private readonly seedNameCounts: ReadonlyMap<string, number>,
    private readonly allowUnregisteredPlainSchemas: boolean,
  ) {
    super()
  }

  override resolveBoundary<T>(schema: PropertySchema<T>): PropertyBoundaryResolution<T> {
    if (isResolvedPropertySchema(schema)) {
      // A resolved schema asserts a durable field id + workspace we cannot
      // re-verify without a snapshot — fail closed.
      return super.resolveBoundary(schema)
    }
    if (isPropertyHandle(schema)) {
      // A code-owned handle is authoritative even without this workspace's
      // projection: decode the stored value with the handle's own codec rather
      // than returning the schema default (the isCollapsed/types boot-window
      // bug). KERNEL handles are unshadowable — registered at Repo construction
      // on every device, so no user schema ever existed at their name — so their
      // codec is unconditionally safe. A PLUGIN seed name CAN collide with a
      // pre-existing/synced user definition we can't detect without a snapshot,
      // so we resolve it with a decode fallback: the common (unshadowed) value
      // decodes correctly, while a shadowed value the plugin's strict codec
      // rejects degrades to the default instead of throwing in a synchronous
      // render. (Revisit once seed-metadata renames can move a handle's key.)
      if (propertySchemaOriginForSeedKey(schema.seedKey) === 'kernel') {
        return {status: 'available', schema}
      }
      return {status: 'available', schema: withDecodeFallback(schema)}
    }
    const seedCount = this.seedNameCounts.get(schema.name) ?? 0
    if (seedCount > 0) {
      return {
        status: 'identity-unavailable',
        reason: seedCount > 1 ? 'ambiguous' : 'shadowed',
      }
    }
    // An unclaimed plain schema: trusted only in the active-workspace boot
    // window. For a foreign workspace we can't confirm it's the winner (its
    // definitions aren't loaded), so it fails closed.
    return this.allowUnregisteredPlainSchemas
      ? {status: 'available', schema}
      : {status: 'identity-unavailable', reason: 'registry-not-workspace-keyed'}
  }
}

/** Select the boundary resolver for a target row workspace. A snapshot that
 * matches the row's workspace resolves faithfully; otherwise the handle-trusting
 * fallback covers the boot window (allowing the active workspace's ambient plain
 * schemas) and genuinely foreign workspaces (code-owned handles only), never
 * synthesising a partial snapshot that would resolve an unloaded plain name. */
export const propertySchemaResolverForWorkspace = (
  snapshot: PropertyDefinitionRegistrySnapshot | null,
  workspaceId: string,
  propertySeedNameCounts: ReadonlyMap<string, number> = new Map(),
  allowUnregisteredPlainSchemas = false,
): PropertySchemaResolver => {
  if (snapshot && snapshot.workspaceId === workspaceId) {
    return new SnapshotPropertySchemaResolver(
      snapshot,
      propertySeedNameCounts,
      allowUnregisteredPlainSchemas,
    )
  }
  return new HandleTrustingPropertySchemaResolver(
    propertySeedNameCounts,
    allowUnregisteredPlainSchemas,
  )
}

const resolved = <T>(
  workspaceId: string,
  fieldId: string,
  behavior: AnyPropertySchema,
  metadata: Pick<PropertyDefinitionMetadata, 'name' | 'hidden' | 'origin'>,
): PropertySchemaResolution<T> => ({
  status: 'resolved',
  schema: {
    name: metadata.name,
    fieldId,
    workspaceId,
    codec: behavior.codec,
    defaultValue: behavior.defaultValue,
    changeScope: behavior.changeScope,
    hidden: metadata.hidden,
    origin: metadata.origin,
  } as ResolvedPropertySchema<T>,
})

class SnapshotPropertySchemaResolver implements PropertySchemaResolver {
  constructor(
    private readonly snapshot: PropertyDefinitionRegistrySnapshot,
    private readonly seedNameCounts: ReadonlyMap<string, number>,
    private readonly allowUnregisteredPlainSchemas: boolean,
  ) {}

  resolve<T>(handle: PropertyHandle<T>): PropertySchemaResolution<T>
  resolve(name: string): PropertySchemaResolution<unknown>
  resolve<T>(input: PropertyHandle<T> | string): PropertySchemaResolution<T> {
    if (typeof input === 'string') return this.resolveName(input) as PropertySchemaResolution<T>
    const declaration = this.snapshot.seedsByKey.get(input.seedKey)
    if (!declaration || input !== declaration) {
      return {status: 'identity-unavailable', reason: 'definition-unavailable'}
    }
    const fieldId = propertyDefinitionBlockId(this.snapshot.workspaceId, declaration.seedKey)
    const metadata = this.snapshot.definitionsByFieldId.get(fieldId)
    if (metadata && metadata.seedKey !== declaration.seedKey) {
      return {status: 'identity-unavailable', reason: 'definition-unavailable'}
    }
    const name = metadata?.name ?? declaration.name
    const winner = this.snapshot.definitionsByName.get(name)?.[0]
    if (winner && winner.fieldId !== fieldId) {
      return {status: 'identity-unavailable', reason: 'shadowed'}
    }
    if (!winner) {
      const synthesized = this.snapshot.seedsByName.get(name) ?? []
      if (synthesized.length !== 1 || synthesized[0] !== declaration) {
        return {status: 'identity-unavailable', reason: 'ambiguous'}
      }
    }
    return resolved<T>(
      this.snapshot.workspaceId,
      fieldId,
      declaration,
      metadata ?? {
        name: declaration.name,
        hidden: declaration.hidden,
        origin: propertySchemaOriginForSeedKey(declaration.seedKey),
      },
    )
  }

  private resolveName(name: string): PropertySchemaResolution<unknown> {
    const winner = this.snapshot.definitionsByName.get(name)?.[0]
    if (winner) return this.resolveField(winner.fieldId)

    const seeds = this.snapshot.seedsByName.get(name) ?? []
    if (seeds.length !== 1) {
      return {
        status: 'identity-unavailable',
        reason: seeds.length > 1 ? 'ambiguous' : 'definition-unavailable',
      }
    }
    return this.resolve(seeds[0]!)
  }

  resolveField<T>(fieldId: string): PropertySchemaResolution<T> {
    const metadata = this.snapshot.definitionsByFieldId.get(fieldId)
    if (!metadata) {
      const declaration = [...this.snapshot.seedsByKey.values()].find(seed =>
        propertyDefinitionBlockId(this.snapshot.workspaceId, seed.seedKey) === fieldId)
      return declaration
        ? this.resolve(declaration) as PropertySchemaResolution<T>
        : {status: 'identity-unavailable', reason: 'definition-unavailable'}
    }
    const winner = this.snapshot.definitionsByName.get(metadata.name)?.[0]
    if (!winner || winner.fieldId !== fieldId) {
      return {status: 'identity-unavailable', reason: 'shadowed'}
    }
    const declaration = metadata.seedKey
      ? this.snapshot.seedsByKey.get(metadata.seedKey)
      : undefined
    const behavior = declaration ?? this.snapshot.schemasByFieldId.get(fieldId)
    if (!behavior) return {status: 'identity-unavailable', reason: 'definition-unavailable'}
    return resolved<T>(this.snapshot.workspaceId, fieldId, behavior, metadata)
  }

  resolveBoundary<T>(schema: PropertySchema<T>): PropertyBoundaryResolution<T> {
    // The ambient map may publish a name-adjusted definition clone or a plain
    // legacy/type-lifted registration. Exact membership proves it is this
    // snapshot's selected entry. Identity-owned names resolve canonically;
    // handles and resolved schemas still validate through their stronger
    // branches before selected plain legacy entries become directly usable.
    const exactSelected = this.snapshot.schemas.get(schema.name) === schema
    if (
      exactSelected &&
      (
        this.snapshot.definitionsByName.has(schema.name) ||
        this.snapshot.seedsByName.has(schema.name)
      )
    ) {
      return this.asBoundaryResolution(
        this.resolveName(schema.name) as PropertySchemaResolution<T>,
      )
    }
    if (isPropertyHandle(schema)) return this.asBoundaryResolution(this.resolve(schema))

    if (isResolvedPropertySchema(schema)) {
      if (schema.workspaceId !== this.snapshot.workspaceId) {
        return {status: 'identity-unavailable', reason: 'registry-not-workspace-keyed'}
      }
      return this.asBoundaryResolution(this.resolveField<T>(schema.fieldId))
    }

    if (exactSelected) return {status: 'available', schema}

    const winner = this.snapshot.definitionsByName.get(schema.name)?.[0]
    if (winner) {
      const winnerBehavior = winner.seedKey
        ? this.snapshot.seedsByKey.get(winner.seedKey)
        : this.snapshot.schemasByFieldId.get(winner.fieldId)
      if (!winnerBehavior) {
        return {status: 'identity-unavailable', reason: 'definition-unavailable'}
      }
      if (winnerBehavior !== schema) {
        return {status: 'identity-unavailable', reason: 'shadowed'}
      }
      return this.asBoundaryResolution(
        resolved<T>(this.snapshot.workspaceId, winner.fieldId, winnerBehavior, winner),
      )
    }

    const synthesized = this.snapshot.seedsByName.get(schema.name) ?? []
    if (synthesized.length > 0) {
      return {
        status: 'identity-unavailable',
        reason: synthesized.length > 1 ? 'ambiguous' : 'shadowed',
      }
    }
    const declarationCount = this.seedNameCounts.get(schema.name) ?? 0
    if (declarationCount > 0) {
      return {
        status: 'identity-unavailable',
        reason: declarationCount > 1 ? 'ambiguous' : 'shadowed',
      }
    }
    if (this.allowUnregisteredPlainSchemas) return {status: 'available', schema}
    return {status: 'identity-unavailable', reason: 'registry-not-workspace-keyed'}
  }

  private asBoundaryResolution<T>(
    resolution: PropertySchemaResolution<T>,
  ): PropertyBoundaryResolution<T> {
    return resolution.status === 'resolved'
      ? {status: 'available', schema: resolution.schema}
      : resolution
  }
}

/** Bind identity resolution to one atomic workspace snapshot. Boundary sites
 * receive this from their owning transaction context in B2; they never pass an
 * ambient active-workspace id into resolve(). */
export const createPropertySchemaResolver = (
  snapshot: PropertyDefinitionRegistrySnapshot,
): PropertySchemaResolver => new SnapshotPropertySchemaResolver(snapshot, new Map(), false)

export const requireWritablePropertySchema = <T>(
  schema: PropertySchema<T>,
  resolver: PropertySchemaResolver,
): PropertySchema<T> => {
  const resolution = resolver.resolveBoundary(schema)
  if (resolution.status !== 'available') {
    throw new PropertySchemaIdentityError(schema.name, resolution.reason)
  }
  // Writes must decode the current stored value with the STRICT codec. The
  // read-only decode fallback (so a synchronous render can't throw on a
  // cross-workspace shadowed value) would, in `setProperty`'s updater form,
  // degrade an undecodable current value to the default and then overwrite it —
  // silently clobbering a value the caller never saw. Recover the pre-fallback
  // schema so an incompatible current value throws (preserving it) instead.
  const strict = strictSchemaByFallback.get(
    resolution.schema as PropertySchema<unknown>,
  )
  return (strict as PropertySchema<T> | undefined) ?? resolution.schema
}

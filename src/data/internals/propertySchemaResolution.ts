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

const isResolvedPropertySchema = <T>(
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
  resolveBoundary<T>(schema: PropertySchema<T>): PropertyBoundaryResolution<T>
}

/** Resolve one projected definition through the workspace's selected name
 * winner, then prove the winner is the same durable field the caller holds. */
export const resolveSelectedPropertyDefinition = (
  metadata: Pick<PropertyDefinitionMetadata, 'fieldId' | 'name'>,
  resolver: PropertySchemaResolver,
): AnyPropertySchema | undefined => {
  const resolution = resolver.resolve(metadata.name)
  return resolution.status === 'resolved' && resolution.schema.fieldId === metadata.fieldId
    ? resolution.schema
    : undefined
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

class TransitionalLegacyPropertySchemaResolver
  extends IdentityUnavailablePropertySchemaResolver {
  constructor(private readonly seedNameCounts: ReadonlyMap<string, number>) {
    super()
  }

  override resolveBoundary<T>(schema: PropertySchema<T>): PropertyBoundaryResolution<T> {
    if (isResolvedPropertySchema(schema)) {
      // A resolved schema asserts a durable field id + workspace we cannot
      // re-verify without a snapshot — fail closed.
      return super.resolveBoundary(schema)
    }
    if (isPropertyHandle(schema)) {
      // A PropertyHandle is code-owned: its seedKey identity is deterministic
      // and `addSchema` forbids user definitions from claiming a seed name, so
      // a seeded handle cannot be shadowed. Its own codec is therefore the
      // authoritative interpretation even before this workspace's definition
      // projection has primed — a read during the boot window must return the
      // stored value, not the schema default. (Revisit once seed-metadata
      // renames can move the stored key.)
      return {status: 'available', schema}
    }
    const seedCount = this.seedNameCounts.get(schema.name) ?? 0
    if (seedCount > 0) {
      return {
        status: 'identity-unavailable',
        reason: seedCount > 1 ? 'ambiguous' : 'shadowed',
      }
    }
    return {status: 'available', schema}
  }
}

/** Select the boundary resolver for a target row workspace. Both stage-0 and
 * active-workspace transitional fallback reject original seed-name claims;
 * foreign/inactive snapshots fail closed for arbitrary plain schemas. */
export const propertySchemaResolverForWorkspace = (
  snapshot: PropertyDefinitionRegistrySnapshot | null,
  workspaceId: string,
  propertySeedNameCounts: ReadonlyMap<string, number> = new Map(),
  allowUnregisteredPlainSchemas = false,
): PropertySchemaResolver => {
  if (!snapshot) {
    return allowUnregisteredPlainSchemas
      ? new TransitionalLegacyPropertySchemaResolver(propertySeedNameCounts)
      : unavailablePropertySchemaResolver
  }
  return snapshot.workspaceId === workspaceId
    ? new SnapshotPropertySchemaResolver(
      snapshot,
      propertySeedNameCounts,
      allowUnregisteredPlainSchemas,
    )
    : unavailablePropertySchemaResolver
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

  private resolveField<T>(fieldId: string): PropertySchemaResolution<T> {
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
  if (resolution.status === 'available') return resolution.schema
  throw new PropertySchemaIdentityError(schema.name, resolution.reason)
}

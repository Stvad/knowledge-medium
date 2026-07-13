import type {
  AnyPropertySchema,
  PropertyHandle,
  PropertySchemaResolution,
  ResolvedPropertySchema,
} from '@/data/api'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'
import type {PropertyDefinitionMetadata} from '@/data/propertyDefinitionMetadata'
import {propertySchemaOriginForSeedKey} from '@/data/propertyDefinitionMetadata'
import type {PropertyDefinitionRegistrySnapshot} from '@/data/propertyDefinitionRegistry'

/** A resolver is created for an owning transaction/workspace registry
 * snapshot; callers supply only the definition handle or name, never a
 * workspace id. */
export interface PropertySchemaResolver {
  resolve<T>(handle: PropertyHandle<T>): PropertySchemaResolution<T>
  resolve(name: string): PropertySchemaResolution<unknown>
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
}

/** Stage-0/mismatch form of the single property-identity primitive. It cannot
 * construct a resolved schema; boundary sites consume a resolver bound to the
 * target row's workspace snapshot. */
export const unavailablePropertySchemaResolver: PropertySchemaResolver =
  new IdentityUnavailablePropertySchemaResolver()

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
  constructor(private readonly snapshot: PropertyDefinitionRegistrySnapshot) {}

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
    if (winner) {
      const declaration = winner.seedKey
        ? this.snapshot.seedsByKey.get(winner.seedKey)
        : undefined
      const behavior = declaration ?? this.snapshot.schemasByFieldId.get(winner.fieldId)
      if (!behavior) return {status: 'identity-unavailable', reason: 'definition-unavailable'}
      return resolved(this.snapshot.workspaceId, winner.fieldId, behavior, winner)
    }

    const seeds = this.snapshot.seedsByName.get(name) ?? []
    if (seeds.length !== 1) {
      return {
        status: 'identity-unavailable',
        reason: seeds.length > 1 ? 'ambiguous' : 'definition-unavailable',
      }
    }
    return this.resolve(seeds[0]!)
  }
}

/** Bind identity resolution to one atomic workspace snapshot. Boundary sites
 * receive this from their owning transaction context in B2; they never pass an
 * ambient active-workspace id into resolve(). */
export const createPropertySchemaResolver = (
  snapshot: PropertyDefinitionRegistrySnapshot,
): PropertySchemaResolver => new SnapshotPropertySchemaResolver(snapshot)

import type {
  PropertyHandle,
  PropertySchemaResolution,
} from '@/data/api'

/** A resolver is created for an owning transaction/workspace registry
 * snapshot; callers supply only the definition handle or name, never a
 * workspace id. Slice B adds the bound factory and resolved branch. */
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

/** Slice-A form of the single property-identity resolution primitive.
 *
 * Today's schema registry is workspace-agnostic, and its user-schema id map
 * does not expose the projector's pinned workspace. Resolving through either
 * would make an ambient active-workspace guess look authoritative during a
 * workspace switch. Until slice B installs workspace-keyed buckets and seeded
 * identities, every request therefore reports identity as unavailable.
 *
 * This unbound instance cannot construct a resolved schema. Boundary sites
 * start consuming resolver instances only in slice B, after the transaction
 * engine can provide a snapshot bound to the target row's workspace. */
export const unavailablePropertySchemaResolver: PropertySchemaResolver =
  new IdentityUnavailablePropertySchemaResolver()

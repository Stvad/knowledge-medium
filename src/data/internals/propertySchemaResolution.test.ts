import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  ChangeScope,
  codecs,
  defineProperty,
  type PropertyHandle,
  type PropertySchemaEntry,
  type PropertySchemaOrigin,
  type ResolvedPropertySchema,
} from '@/data/api'
import {
  propertySchemaResolverForWorkspace,
  unavailablePropertySchemaResolver,
} from './propertySchemaResolution'

describe('property schema identity resolution', () => {
  const entry = defineProperty('test:title', {
    codec: codecs.string,
    defaultValue: '',
    changeScope: ChangeScope.BlockDefault,
  })
  const handle: PropertyHandle<string> = {
    ...entry,
    seedKey: 'system:test/property/title',
  }

  it('keeps identity unavailable until the registry is workspace-keyed', () => {
    expect(unavailablePropertySchemaResolver.resolve(handle)).toEqual({
      status: 'identity-unavailable',
      reason: 'registry-not-workspace-keyed',
    })
    expect(unavailablePropertySchemaResolver.resolve('test:title')).toEqual({
      status: 'identity-unavailable',
      reason: 'registry-not-workspace-keyed',
    })
  })

  describe('boundary resolution before the workspace snapshot is available', () => {
    // Transitional resolver: active-workspace row whose definition projection
    // has not primed yet (the boot window). `null` snapshot + allow-plain.
    const transitional = propertySchemaResolverForWorkspace(null, 'ws-1', new Map(), true)
    // Fully-unavailable resolver: a foreign/inactive workspace snapshot.
    const foreign = propertySchemaResolverForWorkspace(null, 'ws-1', new Map(), false)

    const kernelHandle: PropertyHandle<string> = {
      ...entry,
      seedKey: 'system:kernel-data/property/title',
    }
    const pluginHandle: PropertyHandle<string> = {
      ...entry,
      seedKey: 'my-plugin/property/title',
    }

    it('resolves a kernel handle to itself so boot-window reads see stored values', () => {
      // A kernel handle is unshadowable; a read during the boot window must
      // decode with its own codec, not fall back to the schema default (the bug
      // that returned defaults for seeded props like isCollapsed while the
      // projector primed).
      expect(transitional.resolveBoundary(kernelHandle)).toEqual({
        status: 'available',
        schema: kernelHandle,
      })
    })

    it('fails a plugin handle closed during boot (it may be shadowed by a user schema)', () => {
      // A plugin seed name can collide with a pre-existing/synced user
      // definition; without a snapshot the shadow is undetectable, so decoding
      // with the plugin codec could throw or miscode. Fail closed to the
      // default instead until the projection primes.
      expect(transitional.resolveBoundary(pluginHandle)).toEqual({
        status: 'identity-unavailable',
        reason: 'registry-not-workspace-keyed',
      })
    })

    it('accepts an unclaimed plain schema but rejects one squatting on a seed name', () => {
      expect(transitional.resolveBoundary(entry)).toEqual({status: 'available', schema: entry})
      const seedShadowed = propertySchemaResolverForWorkspace(
        null,
        'ws-1',
        new Map([[entry.name, 1]]),
        true,
      )
      expect(seedShadowed.resolveBoundary(entry)).toEqual({
        status: 'identity-unavailable',
        reason: 'shadowed',
      })
    })

    it('keeps a foreign/inactive workspace fail-closed even for a kernel handle', () => {
      expect(foreign.resolveBoundary(kernelHandle)).toEqual({
        status: 'identity-unavailable',
        reason: 'registry-not-workspace-keyed',
      })
    })
  })

  it('keeps handles assignable as behavioral entries without making entries handles', () => {
    expectTypeOf<PropertyHandle<string>>().toMatchTypeOf<PropertySchemaEntry<string>>()
    expectTypeOf<PropertySchemaEntry<string>>().not.toMatchTypeOf<PropertyHandle<string>>()
    expectTypeOf<ResolvedPropertySchema<string>['fieldId']>().toEqualTypeOf<string>()
    expectTypeOf<ResolvedPropertySchema<string>['workspaceId']>().toEqualTypeOf<string>()

    type StructuralImpostor = PropertySchemaEntry<string> & {
      fieldId: string
      workspaceId: string
      hidden: boolean
      origin: PropertySchemaOrigin
    }
    expectTypeOf<StructuralImpostor>().not.toMatchTypeOf<ResolvedPropertySchema<string>>()
  })
})

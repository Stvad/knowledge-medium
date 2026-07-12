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
import { unavailablePropertySchemaResolver } from './propertySchemaResolution'

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

import { describe, expect, it } from 'vitest'
import { propertySchemasFacet, typesFacet } from '@/data/facets.ts'
import {
  blockContentDecoratorsFacet,
  type BlockResolveContext,
} from '@/extensions/blockInteraction.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import type { BlockRenderer } from '@/types.ts'
import {
  roamTodoStateProp,
  statusProp,
  TODO_TYPE,
  todoPlugin,
} from '../index.tsx'

describe('todoPlugin', () => {
  it('contributes todo type and property schemas', () => {
    const runtime = resolveFacetRuntimeSync(todoPlugin)
    const schemas = runtime.read(propertySchemasFacet)
    const types = runtime.read(typesFacet)

    expect(schemas.get(statusProp.name)).toBe(statusProp)
    expect(schemas.get(roamTodoStateProp.name)).toBe(roamTodoStateProp)
    expect(types.get(TODO_TYPE)?.properties).toEqual([statusProp])
  })

  it('memoizes content decorators per inner renderer', () => {
    const runtime = resolveFacetRuntimeSync(todoPlugin)
    const decorate = runtime.read(blockContentDecoratorsFacet)
    const inner: BlockRenderer = ({block}) => <span>{block.id}</span>
    const context = {} as BlockResolveContext

    expect(decorate(context, inner)).toBe(decorate(context, inner))
  })
})

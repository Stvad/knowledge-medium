import { describe, expect, it } from 'vitest'
import { propertySchemasFacet, typesFacet } from '@/data/facets.ts'
import {
  blockContentDecoratorsFacet,
  type BlockResolveContext,
} from '@/extensions/blockInteraction.ts'
import { actionsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { ActionContextTypes } from '@/shortcuts/types.ts'
import type { BlockRenderer } from '@/types.ts'
import {
  roamTodoStateProp,
  statusProp,
  TODO_TYPE,
  todoPlugin,
} from '../index.tsx'

describe('todoPlugin', () => {
  it('contributes todo type and directly-owned property schemas', () => {
    const runtime = resolveFacetRuntimeSync(todoPlugin)
    const schemas = runtime.read(propertySchemasFacet)
    const types = runtime.read(typesFacet)

    expect(schemas.has(statusProp.name)).toBe(false)
    expect(schemas.get(roamTodoStateProp.name)).toBe(roamTodoStateProp)
    expect(types.get(TODO_TYPE)?.properties).toEqual([statusProp])
  })

  it('contributes Roam-style cmd-enter todo cycle actions', () => {
    const runtime = resolveFacetRuntimeSync(todoPlugin)
    const actions = runtime.read(actionsFacet)

    const normal = actions.find(action => action.id === 'todo.cycle')
    const edit = actions.find(action => action.id === 'edit.cm.todo.cycle')

    expect(normal?.context).toBe(ActionContextTypes.NORMAL_MODE)
    expect(edit?.context).toBe(ActionContextTypes.EDIT_MODE_CM)
    expect(normal?.defaultBinding?.keys).toEqual(['cmd+enter', 'ctrl+enter'])
    expect(edit?.defaultBinding?.keys).toEqual(['cmd+enter', 'ctrl+enter'])
  })

  it('memoizes content decorators per inner renderer', () => {
    const runtime = resolveFacetRuntimeSync(todoPlugin)
    const decorate = runtime.read(blockContentDecoratorsFacet)
    const inner: BlockRenderer = ({block}) => <span>{block.id}</span>
    const context = {} as BlockResolveContext

    expect(decorate(context, inner)).toBe(decorate(context, inner))
  })
})

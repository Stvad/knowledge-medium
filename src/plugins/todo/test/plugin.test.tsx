// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { definitionSeedsFacet, typesFacet } from '@/data/facets.js'
import {
  blockContentDecoratorsFacet,
  type BlockResolveContext,
} from '@/extensions/blockInteraction.js'
import { actionsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { SWIPE_RIGHT_BLOCK_ACTION_ID } from '@/plugins/swipe-quick-actions'
import { ActionContextTypes } from '@/shortcuts/types.js'
import type { BlockRenderer } from '@/types.js'
import {
  roamTodoStateProp,
  statusProp,
  TODO_TYPE,
  todoPlugin,
} from '../index.tsx'

describe('todoPlugin', () => {
  it('contributes both seeded properties and the todo type', () => {
    const runtime = resolveFacetRuntimeSync(todoPlugin)
    const seeds = runtime.read(definitionSeedsFacet)
    const types = runtime.read(typesFacet)

    expect(seeds).toEqual(expect.arrayContaining([statusProp, roamTodoStateProp]))
    expect(types.get(TODO_TYPE)?.properties).toEqual([statusProp])
  })

  it('contributes Roam-style cmd-enter todo cycle actions', () => {
    const runtime = resolveFacetRuntimeSync(todoPlugin)
    const actions = runtime.read(actionsFacet)

    const normal = actions.find(action => action.id === 'todo.cycle')
    const edit = actions.find(action => action.id === 'edit.cm.todo.cycle')

    expect(normal?.context).toBe(ActionContextTypes.NORMAL_MODE)
    expect(edit?.context).toBe(ActionContextTypes.EDIT_MODE_CM)
    expect(actions.find(action => action.id === SWIPE_RIGHT_BLOCK_ACTION_ID)?.context)
      .toBe(ActionContextTypes.NORMAL_MODE)
  })

  it('memoizes content decorators per inner renderer', () => {
    const runtime = resolveFacetRuntimeSync(todoPlugin)
    const decorate = runtime.read(blockContentDecoratorsFacet)
    const inner: BlockRenderer = ({block}) => <span>{block.id}</span>
    const context = {} as BlockResolveContext

    expect(decorate(context, inner)).toBe(decorate(context, inner))
  })
})

import { expect, it } from 'vitest'
import { surfaceRenderScopeId, surfaceRenderScopeParts } from './renderScope'

it('recovers the occurrence and enclosing scope from a nested surface id', () => {
  const parent = surfaceRenderScopeId('board', 'panel:page', 'a:b')
  const scope = surfaceRenderScopeId('notes', parent, 'row:%')
  expect(surfaceRenderScopeParts(scope)).toEqual({surface: 'notes', occurrenceId: 'row:%', parentRenderScopeId: parent})
})

it.each(['panel:row:parent', 'surface.notes:row', 'surface.notes:row:parent:extra', 'surface.notes:%:parent'])(
  'recognizes an invalid surface id %s', scope => expect(surfaceRenderScopeParts(scope)).toBeUndefined(),
)

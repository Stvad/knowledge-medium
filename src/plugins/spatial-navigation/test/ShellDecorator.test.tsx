// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { Block } from '@/data/block'
import type { BlockContextType } from '@/types'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { surfaceRenderScopeId } from '@/utils/renderScope'
import { SpatialNavigationShellDecorator } from '../ShellDecorator'
import { resolveSpatialNavExclusions, spatialNavExclusionsFacet } from '../exclusionsFacet'
import { panelInstances } from '../walker'

afterEach(cleanup)

it('uses the context surface to skip a cell without skipping its row in the same scope', () => {
  const scope = surfaceRenderScopeId('grid', 'panel:p1:root', 'host')
  const block = {} as Block
  const shell = (id: string, context: BlockContextType) => (
    <SpatialNavigationShellDecorator
      resolveContext={{
        block, repo: block.repo, uiStateBlock: block, types: [], isTopLevel: false,
        blockContext: {panelId: 'p1', renderScopeId: scope, isNestedSurface: true, ...context},
      }}
      shellRef={{current: null}}
      contentRef={{current: null}}
      state={{
        shellProps: {'data-block-shell': 'true', 'data-block-id': id, 'data-editing': 'false', tabIndex: 0},
        shortcutSurfaceOptions: {},
      }}>
      {({shellProps}) => <div {...shellProps}/>}
    </SpatialNavigationShellDecorator>
  )
  const {getByTestId} = render(
    <div data-testid="panel" data-panel-id="p1">
      {shell('row', {})}
      {shell('cell', {spatialNavigationSurface: 'grid-cell'})}
      {shell('crumb', {spatialNavigationSurface: 'grid-cell', isBreadcrumb: true})}
    </div>,
  )
  const panel = getByTestId('panel')
  const exclusions = resolveSpatialNavExclusions(resolveFacetRuntimeSync([
    spatialNavExclusionsFacet.of('breadcrumb'),
    spatialNavExclusionsFacet.of('grid-cell'),
  ]))

  expect(panel.querySelector('[data-block-id="cell"]')?.getAttribute('data-block-surface')).toBe('grid-cell')
  expect(panel.querySelector('[data-block-id="crumb"]')?.getAttribute('data-block-surface')).toBe('breadcrumb')
  expect(panelInstances(panel, exclusions).map(el => el.dataset.blockId)).toEqual(['row'])
})

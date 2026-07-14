// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  BlockContextProvider,
  NestedBlockContextProvider,
  RenderSurfaceProvider,
  useBlockContext,
} from '@/context/block.js'
import {
  getEffectiveChildrenVisibility,
} from '@/utils/renderVisibility.js'

const VisibilityProbe = ({blockId}: {blockId: string}) => {
  const context = useBlockContext()
  const visibility = getEffectiveChildrenVisibility(
    context.renderVisibilityPolicy,
    blockId,
    true,
  )
  return (
    <div
      data-testid="visibility-probe"
      data-open={String(visibility.open)}
      data-reason={visibility.reason}
      data-force-open={(context.renderVisibilityPolicy.forceOpenBlockIds ?? []).join(',')}
      data-force-closed={(context.renderVisibilityPolicy.forceClosedBlockIds ?? []).join(',')}
    />
  )
}

describe('RenderSurfaceProvider', () => {
  it('normalizes non-surface root context to the empty policy', () => {
    render(
      <BlockContextProvider initialValue={{layoutBoundary: true}}>
        <VisibilityProbe blockId="root" />
      </BlockContextProvider>,
    )

    const probe = screen.getByTestId('visibility-probe')
    expect(probe).toHaveAttribute('data-open', 'false')
    expect(probe).toHaveAttribute('data-reason', 'stored')
    expect(probe).toHaveAttribute('data-force-open', '')
    expect(probe).toHaveAttribute('data-force-closed', '')
  })

  it('replaces inherited render visibility policy for a new surface', () => {
    render(
      <BlockContextProvider
        initialValue={{
          scopeRootId: 'root',
          renderVisibilityPolicy: {
            forceOpenBlockIds: ['root'],
            forceClosedBlockIds: ['hidden'],
          },
        }}
      >
        <RenderSurfaceProvider
          overrides={{
            isNestedSurface: true,
            scopeRootId: 'target',
            renderScopeId: 'nested:target',
            renderVisibilityPolicy: {},
          }}
        >
          <VisibilityProbe blockId="target" />
        </RenderSurfaceProvider>
      </BlockContextProvider>,
    )

    const probe = screen.getByTestId('visibility-probe')
    expect(probe).toHaveAttribute('data-open', 'false')
    expect(probe).toHaveAttribute('data-reason', 'stored')
    expect(probe).toHaveAttribute('data-force-open', '')
    expect(probe).toHaveAttribute('data-force-closed', '')
  })

  it('keeps the same surface policy through ordinary nested context', () => {
    render(
      <BlockContextProvider
        initialValue={{
          scopeRootId: 'root',
          renderVisibilityPolicy: {},
        }}
      >
        <RenderSurfaceProvider
          overrides={{
            isNestedSurface: true,
            scopeRootId: 'target',
            renderScopeId: 'nested:target',
            renderVisibilityPolicy: {forceOpenBlockIds: ['target']},
          }}
        >
          <NestedBlockContextProvider overrides={{safeMode: true}}>
            <VisibilityProbe blockId="target" />
          </NestedBlockContextProvider>
        </RenderSurfaceProvider>
      </BlockContextProvider>,
    )

    const probe = screen.getByTestId('visibility-probe')
    expect(probe).toHaveAttribute('data-open', 'true')
    expect(probe).toHaveAttribute('data-reason', 'force-open')
    expect(probe).toHaveAttribute('data-force-open', 'target')
  })
})

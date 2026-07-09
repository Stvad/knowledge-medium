// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  BlockContextProvider,
  NestedBlockContextProvider,
  useBlockContext,
} from '@/context/block.js'
import {
  getEffectiveChildrenVisibility,
  renderVisibilityPolicyForBlockContext,
} from '@/utils/renderVisibility.js'

const VisibilityProbe = ({blockId}: {blockId: string}) => {
  const context = useBlockContext()
  const policy = renderVisibilityPolicyForBlockContext(context, context.scopeRootId)
  const visibility = getEffectiveChildrenVisibility(policy, blockId, true)
  return (
    <div
      data-testid="visibility-probe"
      data-open={String(visibility.open)}
      data-reason={visibility.reason}
      data-force-open={(context.forceOpenBlockIds ?? []).join(',')}
      data-force-closed={(context.forceClosedBlockIds ?? []).join(',')}
    />
  )
}

describe('NestedBlockContextProvider render visibility boundary', () => {
  it('clears inherited render visibility policy for a new nested surface', () => {
    render(
      <BlockContextProvider
        initialValue={{
          scopeRootId: 'root',
          forceOpenBlockIds: ['root'],
          forceClosedBlockIds: ['hidden'],
        }}
      >
        <NestedBlockContextProvider
          overrides={{
            isNestedSurface: true,
            scopeRootId: 'root',
          }}
        >
          <VisibilityProbe blockId="root" />
        </NestedBlockContextProvider>
      </BlockContextProvider>,
    )

    const probe = screen.getByTestId('visibility-probe')
    expect(probe).toHaveAttribute('data-open', 'false')
    expect(probe).toHaveAttribute('data-reason', 'stored')
    expect(probe).toHaveAttribute('data-force-open', '')
    expect(probe).toHaveAttribute('data-force-closed', '')
  })

  it('keeps explicit render visibility policy on a nested surface', () => {
    render(
      <BlockContextProvider
        initialValue={{
          scopeRootId: 'root',
          forceOpenBlockIds: ['root'],
        }}
      >
        <NestedBlockContextProvider
          overrides={{
            isNestedSurface: true,
            scopeRootId: 'target',
            forceOpenBlockIds: ['target'],
          }}
        >
          <VisibilityProbe blockId="target" />
        </NestedBlockContextProvider>
      </BlockContextProvider>,
    )

    const probe = screen.getByTestId('visibility-probe')
    expect(probe).toHaveAttribute('data-open', 'true')
    expect(probe).toHaveAttribute('data-reason', 'force-open')
    expect(probe).toHaveAttribute('data-force-open', 'target')
  })
})

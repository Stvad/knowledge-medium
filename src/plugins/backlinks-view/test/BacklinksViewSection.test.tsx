// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { defineVariant } from '@/extensions/variantFacet.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.ts'
import type { BlockResolveContext } from '@/extensions/blockInteraction.ts'
import { backlinksViewFacet, type BacklinksViewRendererProps } from '../facet.ts'
import { BacklinksViewSection } from '../BacklinksViewSection.tsx'

const savedViewRef = vi.hoisted(() => ({
  current: 'empty',
}))

vi.mock('@/data/globalState.ts', () => ({
  useUserPrefsProperty: () => [savedViewRef.current, vi.fn()],
}))

afterEach(() => {
  savedViewRef.current = 'empty'
  cleanup()
})

const block = {id: 'target'} as BacklinksViewRendererProps['block']
const resolveContext = {block} as BlockResolveContext

describe('BacklinksViewSection', () => {
  it('passes picker controls to the selected variant so it can render its empty state', () => {
    const EmptyVariant = ({controls}: BacklinksViewRendererProps) => (
      <div>
        {controls}
        <div>No backlinks.</div>
      </div>
    )
    const VisibleVariant = ({controls}: BacklinksViewRendererProps) => (
      <div>
        {controls}
        <div>visible backlinks</div>
      </div>
    )
    const runtime = resolveFacetRuntimeSync([
      backlinksViewFacet.of(() => defineVariant('empty', 'Empty', EmptyVariant), {source: 'test'}),
      backlinksViewFacet.of(() => defineVariant('visible', 'Visible', VisibleVariant), {source: 'test'}),
    ])

    const view = render(
      <AppRuntimeContextProvider value={runtime}>
        <BacklinksViewSection block={block} resolveContext={resolveContext}/>
      </AppRuntimeContextProvider>,
    )
    expect(screen.getByRole('group', {name: 'Backlinks view'})).toBeInTheDocument()
    expect(screen.getByText('No backlinks.')).toBeInTheDocument()

    savedViewRef.current = 'visible'
    view.rerender(
      <AppRuntimeContextProvider value={runtime}>
        <BacklinksViewSection block={block} resolveContext={resolveContext}/>
      </AppRuntimeContextProvider>,
    )

    expect(screen.getByRole('group', {name: 'Backlinks view'})).toBeInTheDocument()
    expect(screen.getByText('visible backlinks')).toBeInTheDocument()
  })
})

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { defineVariant } from '@/extensions/variantFacet.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.js'
import type { BlockResolveContext } from '@/extensions/blockInteraction.js'
import { backlinksViewFacet, type BacklinksViewRendererProps } from '../facet.ts'
import { BacklinksViewSection } from '../BacklinksViewSection.tsx'

const hookState = vi.hoisted(() => ({
  blockData: {
    current: {properties: {}} as {properties: Record<string, unknown>},
  },
  viewOverride: {
    current: undefined as string | undefined,
  },
  setViewOverride: vi.fn(),
}))

vi.mock('@/hooks/block.ts', () => ({
  useHandle: (_block: unknown, options: {selector: (data: unknown) => unknown}) =>
    options.selector(hookState.blockData.current),
  usePropertyValue: () => [hookState.viewOverride.current, hookState.setViewOverride],
}))

afterEach(() => {
  hookState.blockData.current = {properties: {}}
  hookState.viewOverride.current = undefined
  hookState.setViewOverride.mockReset()
  cleanup()
})

const block = {id: 'target'} as BacklinksViewRendererProps['block']
const resolveContext = {block} as BlockResolveContext

describe('BacklinksViewSection', () => {
  it('passes picker controls to the selected variant so it can render its empty state', () => {
    hookState.viewOverride.current = 'empty'
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

    hookState.viewOverride.current = 'visible'
    view.rerender(
      <AppRuntimeContextProvider value={runtime}>
        <BacklinksViewSection block={block} resolveContext={resolveContext}/>
      </AppRuntimeContextProvider>,
    )

    expect(screen.getByRole('group', {name: 'Backlinks view'})).toBeInTheDocument()
    expect(screen.getByText('visible backlinks')).toBeInTheDocument()
  })

  it('defaults daily note pages to grouped backlinks and other pages to flat backlinks', () => {
    const FlatVariant = () => <div>flat backlinks</div>
    const GroupedVariant = () => <div>grouped backlinks</div>
    const runtime = resolveFacetRuntimeSync([
      backlinksViewFacet.of(() => defineVariant('flat', 'Flat', FlatVariant), {source: 'test'}),
      backlinksViewFacet.of(() => defineVariant('grouped', 'Grouped', GroupedVariant), {source: 'test'}),
    ])

    hookState.blockData.current = {properties: {types: ['daily-note']}}
    const view = render(
      <AppRuntimeContextProvider value={runtime}>
        <BacklinksViewSection block={block} resolveContext={resolveContext}/>
      </AppRuntimeContextProvider>,
    )

    expect(screen.getByText('grouped backlinks')).toBeInTheDocument()

    hookState.blockData.current = {properties: {}}
    view.rerender(
      <AppRuntimeContextProvider value={runtime}>
        <BacklinksViewSection block={block} resolveContext={resolveContext}/>
      </AppRuntimeContextProvider>,
    )

    expect(screen.getByText('flat backlinks')).toBeInTheDocument()
  })

  it('uses a block view override before the derived default', () => {
    hookState.blockData.current = {properties: {types: ['daily-note']}}
    hookState.viewOverride.current = 'flat'
    const FlatVariant = () => <div>flat backlinks</div>
    const GroupedVariant = () => <div>grouped backlinks</div>
    const runtime = resolveFacetRuntimeSync([
      backlinksViewFacet.of(() => defineVariant('flat', 'Flat', FlatVariant), {source: 'test'}),
      backlinksViewFacet.of(() => defineVariant('grouped', 'Grouped', GroupedVariant), {source: 'test'}),
    ])

    render(
      <AppRuntimeContextProvider value={runtime}>
        <BacklinksViewSection block={block} resolveContext={resolveContext}/>
      </AppRuntimeContextProvider>,
    )

    expect(screen.getByText('flat backlinks')).toBeInTheDocument()
  })

  it('writes picker changes to the target block override', () => {
    const FlatVariant = ({controls}: BacklinksViewRendererProps) => (
      <div>
        {controls}
        <div>flat backlinks</div>
      </div>
    )
    const GroupedVariant = ({controls}: BacklinksViewRendererProps) => (
      <div>
        {controls}
        <div>grouped backlinks</div>
      </div>
    )
    const runtime = resolveFacetRuntimeSync([
      backlinksViewFacet.of(() => defineVariant('flat', 'Flat', FlatVariant), {source: 'test'}),
      backlinksViewFacet.of(() => defineVariant('grouped', 'Grouped', GroupedVariant), {source: 'test'}),
    ])

    render(
      <AppRuntimeContextProvider value={runtime}>
        <BacklinksViewSection block={block} resolveContext={resolveContext}/>
      </AppRuntimeContextProvider>,
    )

    fireEvent.click(screen.getByRole('button', {name: 'Grouped'}))

    expect(hookState.setViewOverride).toHaveBeenCalledWith('grouped')
  })

  it('clears the block override when choosing the derived default', () => {
    hookState.blockData.current = {properties: {types: ['daily-note']}}
    hookState.viewOverride.current = 'flat'
    const FlatVariant = ({controls}: BacklinksViewRendererProps) => (
      <div>
        {controls}
        <div>flat backlinks</div>
      </div>
    )
    const GroupedVariant = ({controls}: BacklinksViewRendererProps) => (
      <div>
        {controls}
        <div>grouped backlinks</div>
      </div>
    )
    const runtime = resolveFacetRuntimeSync([
      backlinksViewFacet.of(() => defineVariant('flat', 'Flat', FlatVariant), {source: 'test'}),
      backlinksViewFacet.of(() => defineVariant('grouped', 'Grouped', GroupedVariant), {source: 'test'}),
    ])

    render(
      <AppRuntimeContextProvider value={runtime}>
        <BacklinksViewSection block={block} resolveContext={resolveContext}/>
      </AppRuntimeContextProvider>,
    )

    fireEvent.click(screen.getByRole('button', {name: 'Grouped'}))

    expect(hookState.setViewOverride).toHaveBeenCalledWith(undefined)
  })

  it('does not bubble backlink surface clicks to the parent block shell', () => {
    const surfaceClick = vi.fn()
    const parentBlockClick = vi.fn()
    const BacklinkVariant = () => (
      <div data-testid="backlink-surface" onClick={surfaceClick}>
        Backlink chrome
      </div>
    )
    const runtime = resolveFacetRuntimeSync([
      backlinksViewFacet.of(() => defineVariant('empty', 'Empty', BacklinkVariant), {source: 'test'}),
    ])

    render(
      <div onClick={parentBlockClick}>
        <AppRuntimeContextProvider value={runtime}>
          <BacklinksViewSection block={block} resolveContext={resolveContext}/>
        </AppRuntimeContextProvider>
      </div>,
    )

    fireEvent.click(screen.getByTestId('backlink-surface'))

    expect(surfaceClick).toHaveBeenCalledOnce()
    expect(parentBlockClick).not.toHaveBeenCalled()
  })
})

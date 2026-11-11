// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useEffect, useSyncExternalStore } from 'react'
import type { Block } from '@/data/block'
import type { BlockContextType, BlockRenderer } from '@/types'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { blockGutterItemsFacet, type BlockResolveContext } from '@/extensions/blockInteraction'
import { resolveFacetRuntimeSync, type AppExtension } from '@/facets/facet'
import {
  BlockGutterHost,
  createGutterControls,
  GutterTextBelowHeader,
  useGutterHeader,
  useGutterText,
  type GutterControls,
} from './BlockGutter'

afterEach(cleanup)

const block = {id: 'block-1'} as Block

const contextFor = (blockContext: Partial<BlockContextType> = {}): BlockResolveContext => ({
  block,
  blockContext: blockContext as BlockContextType,
} as BlockResolveContext)

const Label = (label: string): BlockRenderer => {
  const Item = () => <span data-testid="item">{label}</span>
  Item.displayName = `Item(${label})`
  return Item
}

const renderHost = (
  extensions: AppExtension[],
  {
    blockContext,
    controls = createGutterControls(),
    content = <span>content</span>,
  }: {blockContext?: Partial<BlockContextType>; controls?: GutterControls; content?: React.ReactNode} = {},
) => render(
  <AppRuntimeContextProvider value={resolveFacetRuntimeSync(extensions)}>
    <BlockGutterHost resolveContext={contextFor(blockContext)} controls={controls}>
      {content}
    </BlockGutterHost>
  </AppRuntimeContextProvider>,
)

const itemTexts = (selector: string) =>
  [...document.querySelectorAll(`${selector} [data-testid="item"]`)].map(node => node.textContent)

describe('BlockGutterHost', () => {
  it('puts each item in its corner, in contribution order', () => {
    renderHost([
      blockGutterItemsFacet.of(() => ({corner: 'top-right', component: Label('second')}), {source: 'b', precedence: 10}),
      blockGutterItemsFacet.of(() => [
        {corner: 'top-right', component: Label('first')},
        {corner: 'bottom-right', component: Label('count')},
      ], {source: 'a'}),
      blockGutterItemsFacet.of(() => null, {source: 'c'}),
    ])

    expect(itemTexts('.km-gutter-top-right')).toEqual(['first', 'second'])
    expect(itemTexts('.km-gutter-bottom-right')).toEqual(['count'])
  })

  it('never remounts the content when an item starts showing', () => {
    let visible = false
    const listeners = new Set<() => void>()
    const ToggledItem = () => {
      const show = useSyncExternalStore(
        listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
        () => visible,
      )
      return show ? <span data-testid="item">pill</span> : null
    }
    let mounts = 0
    const Content = () => {
      useEffect(() => { mounts += 1 }, [])
      return <span>content</span>
    }

    renderHost(
      [blockGutterItemsFacet.of(() => ({corner: 'top-right', component: ToggledItem}), {source: 'test'})],
      {content: <Content/>},
    )
    expect(screen.queryByTestId('item')).toBeNull()

    act(() => {
      visible = true
      listeners.forEach(listener => listener())
    })

    expect(screen.getByTestId('item')).toBeTruthy()
    expect(mounts).toBe(1)
  })

  it.each([
    ['breadcrumb', {isBreadcrumb: true}],
    ['reference', {isReference: true}],
  ])('shows no gutter in a %s', (_name, blockContext) => {
    renderHost(
      [blockGutterItemsFacet.of(() => ({corner: 'top-right', component: Label('pill')}), {source: 'test'})],
      {blockContext},
    )

    expect(screen.getByText('content')).toBeTruthy()
    expect(document.querySelector('.km-gutter-host')).toBeNull()
    expect(screen.queryByTestId('item')).toBeNull()
  })

  it('puts the layout\'s own control after the facet\'s items, marked when it may overlay', () => {
    const controls = createGutterControls()
    renderHost(
      [blockGutterItemsFacet.of(() => ({corner: 'top-right', component: Label('pill')}), {source: 'test'})],
      {controls},
    )
    expect(document.querySelector('[data-gutter-overlay]')).toBeNull()

    act(() => controls.set({corner: 'top-right', component: Label('expand'), overlay: true}))

    expect(itemTexts('.km-gutter-top-right')).toEqual(['pill', 'expand'])
    const slots = document.querySelectorAll('.km-gutter-top-right > [data-gutter-item]')
    expect(slots[0].hasAttribute('data-gutter-overlay')).toBe(false)
    expect(slots[1].hasAttribute('data-gutter-overlay')).toBe(true)
  })

  it('keeps the content up while an item suspends or throws', () => {
    const Suspends = () => { throw new Promise(() => {}) }
    const Throws = () => { throw new Error('item boom') }

    renderHost([
      blockGutterItemsFacet.of(() => [
        {corner: 'top-right', component: Suspends},
        {corner: 'top-right', component: Throws},
      ], {source: 'test'}),
    ])

    expect(screen.getByText('content')).toBeTruthy()
    expect(screen.getByRole('img', {name: 'Gutter item failed'}).getAttribute('title')).toBe('item boom')
  })
})

describe('useGutterText', () => {
  const TextOf = ({of}: {of: Block}) => {
    const attach = useGutterText(of)
    return <div ref={attach} data-testid="text" data-attachable={attach ? 'yes' : 'no'}/>
  }

  it('registers the block\'s own text, which the host then lays out', () => {
    renderHost([], {content: <TextOf of={block}/>})

    expect(screen.getByTestId('text').dataset.attachable).toBe('yes')
    expect(document.querySelector('.km-gutter-host')?.getAttribute('data-gutter-top-right')).toBe('column')
  })

  it('leaves another block\'s text alone', () => {
    renderHost([], {content: <TextOf of={{id: 'other'} as Block}/>})

    expect(screen.getByTestId('text').dataset.attachable).toBe('no')
    expect(document.querySelector('.km-gutter-host')?.getAttribute('data-gutter-top-right')).toBe('none')
  })

  it('keeps the registration when the same element is attached again', () => {
    // BlockEditor hands CodeMirror an inline ref, so the editor's element is
    // detached and re-attached on every render.
    type Attach = ReturnType<typeof useGutterText>
    const Capture = ({onAttach}: {onAttach: (attach: Attach) => void}) => {
      const attach = useGutterText(block)
      useEffect(() => onAttach(attach), [attach, onAttach])
      return <div ref={attach} data-testid="text"/>
    }
    let attach: Attach
    renderHost([], {content: <Capture onAttach={captured => { attach = captured }}/>})
    const text = screen.getByTestId('text')
    // Stands for a flow decision the observer would have made.
    text.setAttribute('data-gutter-flow', '')

    act(() => {
      attach!(null)
      attach!(text)
    })

    expect(text.hasAttribute('data-gutter-flow')).toBe(true)
  })

  it('keeps a newer registration when an older one is released', () => {
    const Both = ({showFirst}: {showFirst: boolean}) => (
      <>
        {showFirst && <TextOf of={block}/>}
        <TextOf of={block}/>
      </>
    )
    const view = renderHost([], {content: <Both showFirst/>})
    const host = () => document.querySelector('.km-gutter-host')?.getAttribute('data-gutter-top-right')
    expect(host()).toBe('column')

    view.rerender(
      <AppRuntimeContextProvider value={resolveFacetRuntimeSync([])}>
        <BlockGutterHost resolveContext={contextFor()} controls={createGutterControls()}>
          <Both showFirst={false}/>
        </BlockGutterHost>
      </AppRuntimeContextProvider>,
    )

    expect(host()).toBe('column')
  })

  it('gives the first line to a header drawn above the text', () => {
    const Header = () => {
      const header = useGutterHeader(block)
      return <div {...header} data-testid="header"/>
    }
    renderHost([], {content: (
      <>
        <Header/>
        <GutterTextBelowHeader><TextOf of={block}/></GutterTextBelowHeader>
      </>
    )})

    expect(screen.getByTestId('header').hasAttribute('data-gutter-header')).toBe(true)
    expect(screen.getByTestId('text').dataset.attachable).toBe('no')
    expect(document.querySelector('.km-gutter-host')?.getAttribute('data-gutter-top-right')).toBe('column')
  })

  it('does nothing outside a host', () => {
    render(<TextOf of={block}/>)

    expect(screen.getByTestId('text').dataset.attachable).toBe('no')
  })
})

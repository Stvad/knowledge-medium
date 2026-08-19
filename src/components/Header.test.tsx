// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { headerItemsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.js'
import { Header } from './Header.tsx'

const StartItem = () => <button type="button" className="hidden md:inline-flex">Start</button>
const EndItem = () => <button type="button">End</button>

describe('Header', () => {
  it('keeps the mobile toolbar compact without reserving hidden start width', () => {
    const runtime = resolveFacetRuntimeSync([
      headerItemsFacet.of({
        id: 'start',
        region: 'start',
        component: StartItem,
      }),
      headerItemsFacet.of({
        id: 'end',
        region: 'end',
        component: EndItem,
      }),
    ])

    const {container} = render(
      <AppRuntimeContextProvider value={runtime}>
        <Header/>
      </AppRuntimeContextProvider>,
    )

    const shell = container.firstElementChild as HTMLElement
    expect(shell).toHaveClass('flex-nowrap', 'px-2', 'py-1')

    const [startRegion, endRegion] = Array.from(shell.children) as HTMLElement[]
    expect(startRegion).toHaveClass('shrink-0')
    expect(startRegion).not.toHaveClass('flex-1')
    expect(endRegion).toHaveClass('ml-auto', 'flex-1', 'overflow-hidden')
  })
})

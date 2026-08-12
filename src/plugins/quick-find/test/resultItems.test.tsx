// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { LinkTargetBlockMatch } from '@/utils/linkTargetAutocomplete.js'
import { QuickFindList } from '../QuickFind.tsx'
import { blockResultItems } from '../resultItems.tsx'
import { quickFindSelectionAction } from '../selection.ts'

afterEach(() => cleanup())

const match = (blockId: string, content: string): LinkTargetBlockMatch =>
  ({blockId, content, label: content})

const renderBlocks = (
  blocks: LinkTargetBlockMatch[],
  crumbs: ReadonlyMap<string, readonly string[]>,
) => render(
  <QuickFindList
    emptyMessage="No results."
    groups={[{heading: 'Blocks', items: blockResultItems(blocks, crumbs)}]}
    onQueryChange={() => undefined}
    onSelect={() => undefined}
    onValueChange={() => undefined}
    query="sync"
    value=""
  />,
)

const crumbLineOf = (option: HTMLElement) =>
  option.querySelector('[data-block-crumbs]')

describe('blockResultItems', () => {
  it('labels each row with ITS OWN ancestor path', () => {
    renderBlocks(
      [match('block-1', 'Sync notes'), match('block-2', 'Sync design')],
      new Map([
        ['block-1', ['Project Alpha', 'Meetings']],
        ['block-2', ['Reading', 'Papers']],
      ]),
    )

    expect(crumbLineOf(screen.getByRole('option', {name: /Sync notes/})))
      .toHaveTextContent('Project Alpha › Meetings')
    expect(crumbLineOf(screen.getByRole('option', {name: /Sync design/})))
      .toHaveTextContent('Reading › Papers')
  })

  it('keeps the crumb line present while crumbs are still loading', () => {
    // The line is the reserved space that stops the rows below it from
    // jumping when the batched ancestor load resolves. Rendering it only
    // once there is text to put in it would reintroduce exactly that jump.
    renderBlocks([match('block-1', 'Sync notes')], new Map())

    const line = crumbLineOf(screen.getByRole('option', {name: 'Sync notes'}))
    expect(line).toBeInTheDocument()
    expect(line).toBeEmptyDOMElement()
  })

  it('keeps the crumb line present for a block that has no ancestors', () => {
    renderBlocks([match('block-1', 'Sync notes')], new Map([['block-1', []]]))

    expect(crumbLineOf(screen.getByRole('option', {name: 'Sync notes'})))
      .toBeInTheDocument()
  })

  it('still selects the block it was built for', () => {
    // Through the real parser, not a substring check: the row's value has
    // to survive `quickFindSelectionAction`'s `kind:payload` split, which
    // a bare block id would not (it would parse as no kind at all).
    const [item] = blockResultItems([match('block-1', 'Sync notes')], new Map())

    expect(quickFindSelectionAction(item.value, 'jump'))
      .toEqual({kind: 'open-block', blockId: 'block-1', target: 'jump'})
  })
})

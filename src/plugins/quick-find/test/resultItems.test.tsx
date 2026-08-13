// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TypeContribution } from '@/data/api'
import type { LinkTargetBlockMatch } from '@/utils/linkTargetAutocomplete.js'
import { QuickFindList } from '../QuickFind.tsx'
import { blockResultItems, recentResultItems, type ResultRowContext } from '../resultItems.tsx'
import { quickFindSelectionAction } from '../selection.ts'

afterEach(() => cleanup())

const match = (
  blockId: string,
  content: string,
  typeIds: readonly string[] = [],
): LinkTargetBlockMatch =>
  ({blockId, content, label: content, parentId: `${blockId}-parent`, typeIds})

const typeRegistry = (
  ...types: {id: string; label?: string; hideFromBlockDisplay?: boolean}[]
): ReadonlyMap<string, TypeContribution> => new Map(types.map(type => [type.id, type]))

const rowContext = (
  crumbsByBlockId: ReadonlyMap<string, readonly string[]> = new Map(),
  types: ReadonlyMap<string, TypeContribution> = typeRegistry(),
): ResultRowContext => ({crumbsByBlockId, typeRegistry: types})

const renderBlocks = (
  blocks: LinkTargetBlockMatch[],
  context: ResultRowContext = rowContext(),
) => render(
  <QuickFindList
    emptyMessage="No results."
    groups={[{heading: 'Blocks', items: blockResultItems(blocks, context)}]}
    onQueryChange={() => undefined}
    onSelect={() => undefined}
    onValueChange={() => undefined}
    query="sync"
    value=""
  />,
)

const crumbLineOf = (option: HTMLElement) =>
  option.querySelector('[data-block-crumbs]')

const chipLabelsOf = (option: HTMLElement) =>
  [...option.querySelectorAll('[title]')].map(chip => chip.textContent)

describe('blockResultItems', () => {
  it('labels each row with ITS OWN ancestor path', () => {
    renderBlocks(
      [match('block-1', 'Sync notes'), match('block-2', 'Sync design')],
      rowContext(new Map([
        ['block-1', ['Project Alpha', 'Meetings']],
        ['block-2', ['Reading', 'Papers']],
      ])),
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
    renderBlocks([match('block-1', 'Sync notes')])

    const line = crumbLineOf(screen.getByRole('option', {name: 'Sync notes'}))
    expect(line).toBeInTheDocument()
    expect(line).toBeEmptyDOMElement()
  })

  it('keeps the crumb line present for a block that has no ancestors', () => {
    renderBlocks([match('block-1', 'Sync notes')], rowContext(new Map([['block-1', []]])))

    expect(crumbLineOf(screen.getByRole('option', {name: 'Sync notes'})))
      .toBeInTheDocument()
  })

  it('still selects the block it was built for', () => {
    // Through the real parser, not a substring check: the row's value has
    // to survive `quickFindSelectionAction`'s `kind:payload` split, which
    // a bare block id would not (it would parse as no kind at all).
    const [item] = blockResultItems([match('block-1', 'Sync notes')], rowContext())

    expect(quickFindSelectionAction(item.value, 'jump'))
      .toEqual({kind: 'open-block', blockId: 'block-1', target: 'jump'})
  })

  it('shows what KIND of thing the row is, beside where it lives', () => {
    renderBlocks(
      [match('block-1', 'Ada Lovelace', ['person'])],
      rowContext(new Map([['block-1', ['People']]]), typeRegistry({id: 'person', label: 'Person'})),
    )

    const option = screen.getByRole('option', {name: /Ada Lovelace/})
    expect(chipLabelsOf(option)).toEqual(['#Person'])
    // Both facts on the one reserved line — the chip does not push the
    // path onto a second row.
    expect(crumbLineOf(option)).toHaveTextContent('People')
  })

  it('shows nothing for a type whose chip is hidden on the block itself', () => {
    // `page` sits on every page. Reusing `hideFromBlockDisplay` is what
    // keeps an untagged page's line honestly empty instead of stamping
    // every single row with "#Page".
    renderBlocks(
      [match('block-1', 'Project Alpha', ['page'])],
      rowContext(new Map(), typeRegistry({id: 'page', label: 'Page', hideFromBlockDisplay: true})),
    )

    expect(chipLabelsOf(screen.getByRole('option', {name: /Project Alpha/}))).toEqual([])
  })

  it('caps the chips so they cannot crowd out the path', () => {
    renderBlocks(
      [match('block-1', 'Ada Lovelace', ['person', 'author', 'mathematician'])],
      rowContext(new Map(), typeRegistry(
        {id: 'person', label: 'Person'},
        {id: 'author', label: 'Author'},
        {id: 'mathematician', label: 'Mathematician'},
      )),
    )

    expect(chipLabelsOf(screen.getByRole('option', {name: /Ada Lovelace/})))
      .toEqual(['#Person', '#Author'])
  })

  it('gives Recent rows the same reserved crumb line, and the same types', () => {
    // Recents record whatever was navigated to, which is often a block
    // partway down a page — the bare label alone is as unplaceable as a
    // content match was before crumbs.
    render(
      <QuickFindList
        emptyMessage="Type to search."
        groups={[{
          heading: 'Recent',
          items: recentResultItems(
            [{blockId: 'block-1', label: 'Sync notes', typeIds: ['person']}],
            rowContext(
              new Map([['block-1', ['Project Alpha', 'Meetings']]]),
              typeRegistry({id: 'person', label: 'Person'}),
            ),
          ),
        }]}
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        onValueChange={() => undefined}
        query=""
        value=""
      />,
    )

    const option = screen.getByRole('option', {name: /Sync notes/})
    expect(crumbLineOf(option)).toHaveTextContent('Project Alpha › Meetings')
    expect(chipLabelsOf(option)).toEqual(['#Person'])
  })
})

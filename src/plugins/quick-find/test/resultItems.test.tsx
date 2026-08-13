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

const blocksList = (
  blocks: LinkTargetBlockMatch[],
  context: ResultRowContext,
) => (
  <QuickFindList
    emptyMessage="No results."
    groups={[{heading: 'Blocks', items: blockResultItems(blocks, context)}]}
    onQueryChange={() => undefined}
    onSelect={() => undefined}
    onValueChange={() => undefined}
    query="sync"
    value=""
  />
)

const renderBlocks = (
  blocks: LinkTargetBlockMatch[],
  context: ResultRowContext = rowContext(),
) => render(blocksList(blocks, context))

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

  it('keeps the crumb line present while a PARENTED block\'s crumbs load', () => {
    // The line is the reserved space that stops the rows below it from
    // jumping when the batched ancestor load resolves. Rendering it only
    // once there is text to put in it would reintroduce exactly that jump.
    renderBlocks([match('block-1', 'Sync notes')])

    const line = crumbLineOf(screen.getByRole('option', {name: 'Sync notes'}))
    expect(line).toBeInTheDocument()
    expect(line).toBeEmptyDOMElement()
  })

  it('reserves no line for a ROOT block, whose crumbs can only come back empty', () => {
    // `manyAncestors` walks parents, so a parentless block resolves to an
    // empty chain by construction — nothing is in flight that could arrive
    // and shove the rows below. Reserving anyway left every root-level
    // result holding a blank line forever, which reads as a load that
    // failed rather than as a block with no path.
    renderBlocks([{...match('block-1', 'Project Alpha'), parentId: null}])

    expect(crumbLineOf(screen.getByRole('option', {name: 'Project Alpha'})))
      .not.toBeInTheDocument()
  })

  it('holds the line for a type the registry cannot name YET', () => {
    // The row's `typeIds` are fixed, but the registry that turns them into
    // chips is live: cold start installs the facet runtime twice, and
    // UserTypesService projects user-defined types later still. Gating the
    // reservation on RESOLVED chips meant this row painted with no line and
    // then grew one on the next render — the reflow the reserved line
    // exists to prevent, and Recents hit it hardest since they render the
    // instant the dialog opens.
    const blocks = [{...match('block-1', 'Ada Lovelace', ['person']), parentId: null}]
    const {rerender} = render(blocksList(blocks, rowContext(new Map(), typeRegistry())))

    const before = crumbLineOf(screen.getByRole('option', {name: /Ada Lovelace/}))
    expect(before).toBeInTheDocument()
    expect(before).toBeEmptyDOMElement()

    rerender(blocksList(
      blocks,
      rowContext(new Map(), typeRegistry({id: 'person', label: 'Person'})),
    ))

    const option = screen.getByRole('option', {name: /Ada Lovelace/})
    expect(crumbLineOf(option)).toBeInTheDocument()
    expect(chipLabelsOf(option)).toEqual(['#Person'])
  })

  it('keeps a plain page collapsed across a registry change', () => {
    // The other direction of the same invariant: `page` is a kernel seed
    // that resolves hidden on the first wave and stays hidden, so a plain
    // page must not acquire a line when the registry later grows.
    const blocks = [{...match('block-1', 'Project Alpha', ['page']), parentId: null}]
    const pageType = {id: 'page', label: 'Page', hideFromBlockDisplay: true}
    const {rerender} = render(blocksList(blocks, rowContext(new Map(), typeRegistry(pageType))))

    expect(crumbLineOf(screen.getByRole('option', {name: 'Project Alpha'})))
      .not.toBeInTheDocument()

    rerender(blocksList(
      blocks,
      rowContext(new Map(), typeRegistry(pageType, {id: 'person', label: 'Person'})),
    ))

    expect(crumbLineOf(screen.getByRole('option', {name: 'Project Alpha'})))
      .not.toBeInTheDocument()
  })

  it('still gives a root block a line when it has types to put there', () => {
    renderBlocks(
      [{...match('block-1', 'Project Alpha', ['person']), parentId: null}],
      rowContext(new Map(), typeRegistry({id: 'person', label: 'Person'})),
    )

    expect(chipLabelsOf(screen.getByRole('option', {name: /Project Alpha/})))
      .toEqual(['#Person'])
  })

  it('shows a path that arrives despite a payload claiming no parent', () => {
    // `searchByContent` declares no row dependency, so a block re-parented
    // since the query can arrive claiming `parentId: null` and still
    // resolve a real path. Dropping it would be worse than the row growing.
    renderBlocks(
      [{...match('block-1', 'Sync notes'), parentId: null}],
      rowContext(new Map([['block-1', ['Project Alpha']]])),
    )

    expect(crumbLineOf(screen.getByRole('option', {name: /Sync notes/})))
      .toHaveTextContent('Project Alpha')
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

  it('puts the chips BEFORE the crumb box, so their position never depends on it', () => {
    // The crumb box renders even when empty, and an empty flex item still
    // spaces its siblings — so crumbs-first put the chip a `gap` in from
    // the line on a block with no path, then slid it right by the whole
    // path width when the batched ancestor load landed. Last, the box
    // costs nothing.
    renderBlocks(
      [match('block-1', 'Ada Lovelace', ['person'])],
      rowContext(new Map(), typeRegistry({id: 'person', label: 'Person'})),
    )

    const option = screen.getByRole('option', {name: /Ada Lovelace/})
    const chip = option.querySelector('[title]')!
    const crumbs = option.querySelector('[data-block-crumbs]')!

    expect(chip.compareDocumentPosition(crumbs))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
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
            [{blockId: 'block-1', label: 'Sync notes', typeIds: ['person'], parentId: 'page-1'}],
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

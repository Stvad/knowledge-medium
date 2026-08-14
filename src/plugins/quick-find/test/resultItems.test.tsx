// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TypeContribution } from '@/data/api'
import type { LinkTargetBlockMatch } from '@/utils/linkTargetAutocomplete.js'
import { QuickFindList } from '../QuickFind.tsx'
import {
  aliasResultItems,
  blockResultItems,
  recentResultItems,
  type ResultRowContext,
} from '../resultItems.tsx'
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
  it('labels each row with ITS OWN ancestor path and ITS OWN types', () => {
    // Both mappings are per-row, and both are worth proving with more than
    // one row on screen: an index-based mix-up would read as plausible
    // context on every row while belonging to the block next to it.
    renderBlocks(
      [match('block-1', 'Sync notes', ['person']), match('block-2', 'Sync design', ['author'])],
      rowContext(
        new Map([
          ['block-1', ['Project Alpha', 'Meetings']],
          ['block-2', ['Reading', 'Papers']],
        ]),
        typeRegistry({id: 'person', label: 'Person'}, {id: 'author', label: 'Author'}),
      ),
    )

    const notes = screen.getByRole('option', {name: /Sync notes/})
    const design = screen.getByRole('option', {name: /Sync design/})

    expect(crumbLineOf(notes)).toHaveTextContent('Project Alpha › Meetings')
    expect(chipLabelsOf(notes)).toEqual(['#Person'])
    expect(crumbLineOf(design)).toHaveTextContent('Reading › Papers')
    expect(chipLabelsOf(design)).toEqual(['#Author'])
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

  it('adds only a chip, not a line, when the registry learns a type late', () => {
    // The row's `typeIds` are fixed, but the registry that names them is
    // live: cold start installs the facet runtime twice, and
    // UserTypesService projects user-defined types later still. Chips
    // therefore have to land somewhere whose presence they do not decide —
    // the text line, which always exists. A row that gains a chip must
    // gain nothing else.
    const blocks = [{...match('block-1', 'Ada Lovelace', ['person']), parentId: null}]
    const {rerender} = render(blocksList(blocks, rowContext(new Map(), typeRegistry())))

    const before = screen.getByRole('option', {name: /Ada Lovelace/})
    expect(crumbLineOf(before)).not.toBeInTheDocument()
    expect(chipLabelsOf(before)).toEqual([])

    rerender(blocksList(
      blocks,
      rowContext(new Map(), typeRegistry({id: 'person', label: 'Person'})),
    ))

    const after = screen.getByRole('option', {name: /Ada Lovelace/})
    expect(chipLabelsOf(after)).toEqual(['#Person'])
    // Same structure as before: no line appeared underneath the chip.
    expect(crumbLineOf(after)).not.toBeInTheDocument()
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

  it('holds the line when a user-defined type hides itself mid-dialog', () => {
    // The reverse, and the harder one: `hideFromBlockDisplay` is an
    // ordinary checkbox on a user-defined type's own definition block, so
    // a REGISTERED id's displayability changes under a rendered row and
    // the id never leaves the registry. Losing the chip must not cost the
    // row a line either.
    const blocks = [{...match('block-1', 'Ada Lovelace', ['person']), parentId: null}]
    const visible = typeRegistry({id: 'person', label: 'Person'})
    const hidden = typeRegistry({id: 'person', label: 'Person', hideFromBlockDisplay: true})
    const {rerender} = render(blocksList(blocks, rowContext(new Map(), visible)))

    const before = screen.getByRole('option', {name: /Ada Lovelace/})
    expect(chipLabelsOf(before)).toEqual(['#Person'])
    expect(crumbLineOf(before)).not.toBeInTheDocument()

    rerender(blocksList(blocks, rowContext(new Map(), hidden)))

    const after = screen.getByRole('option', {name: /Ada Lovelace/})
    expect(chipLabelsOf(after)).toEqual([])
    expect(crumbLineOf(after)).not.toBeInTheDocument()
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

  it('puts the chips on the TEXT line, after the text, not on the crumb line', () => {
    // Where the chips live is the whole reason the row's height no longer
    // depends on the type registry: the text line always exists and is
    // taller than a chip, so a chip arriving or leaving cannot reflow it.
    // On the crumb line — whose presence IS conditional — it could.
    renderBlocks(
      [match('block-1', 'Ada Lovelace', ['person'])],
      rowContext(
        new Map([['block-1', ['People']]]),
        typeRegistry({id: 'person', label: 'Person'}),
      ),
    )

    const option = screen.getByRole('option', {name: /Ada Lovelace/})
    const crumbs = option.querySelector('[data-block-crumbs]')!
    const chip = option.querySelector('[title]')!

    expect(crumbs.contains(chip)).toBe(false)
    // Trailing the text it describes, on that text's own line.
    const text = [...option.querySelectorAll('span')].find(el => el.textContent === 'Ada Lovelace')!
    expect(text.compareDocumentPosition(chip)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(text.parentElement).toBe(chip.parentElement)
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

  it('gives Recent rows the same reserved crumb line, and their own types', () => {
    // Recents record whatever was navigated to, which is often a block
    // partway down a page — the bare label alone is as unplaceable as a
    // content match was before crumbs. Two rows, because one row cannot
    // tell a per-item mapping from an index-based mix-up.
    render(
      <QuickFindList
        emptyMessage="Type to search."
        groups={[{
          heading: 'Recent',
          items: recentResultItems(
            [
              {blockId: 'block-1', label: 'Sync notes', typeIds: ['person'], parentId: 'page-1'},
              {blockId: 'block-2', label: 'Sync design', typeIds: ['author'], parentId: 'page-2'},
            ],
            rowContext(
              new Map([
                ['block-1', ['Project Alpha', 'Meetings']],
                ['block-2', ['Reading', 'Papers']],
              ]),
              typeRegistry({id: 'person', label: 'Person'}, {id: 'author', label: 'Author'}),
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

    const notes = screen.getByRole('option', {name: /Sync notes/})
    const design = screen.getByRole('option', {name: /Sync design/})
    expect(crumbLineOf(notes)).toHaveTextContent('Project Alpha › Meetings')
    expect(chipLabelsOf(notes)).toEqual(['#Person'])
    expect(crumbLineOf(design)).toHaveTextContent('Reading › Papers')
    expect(chipLabelsOf(design)).toEqual(['#Author'])
  })
})

describe('aliasResultItems', () => {
  const aliasRow = (
    alias: string,
    blockId: string,
    typeIds: readonly string[] = [],
  ) => ({alias, blockId, content: alias, typeIds})

  it('tags a page found BY NAME, the case where the tag disambiguates most', () => {
    // A page carries its tags in Recents, so losing them the moment you
    // typed its name read as a bug — and this is the group where
    // "#person or #project?" is the question being asked.
    render(
      <QuickFindList
        emptyMessage="No results."
        groups={[{
          heading: 'Pages',
          items: aliasResultItems(
            [aliasRow('Ada Lovelace', 'block-1', ['person'])],
            rowContext(new Map(), typeRegistry({id: 'person', label: 'Person'})),
          ),
        }]}
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        onValueChange={() => undefined}
        query="ada"
        value=""
      />,
    )

    expect(chipLabelsOf(screen.getByRole('option', {name: /Ada Lovelace/})))
      .toEqual(['#Person'])
  })

  it('renders the row before its types have been read', () => {
    // Alias rows have no properties on them, so types land on the SECOND
    // search callback. The row must be complete without them, and gaining
    // one later must cost it nothing.
    render(
      <QuickFindList
        emptyMessage="No results."
        groups={[{
          heading: 'Pages',
          items: aliasResultItems([aliasRow('Ada Lovelace', 'block-1')], rowContext()),
        }]}
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        onValueChange={() => undefined}
        query="ada"
        value=""
      />,
    )

    const option = screen.getByRole('option', {name: /Ada Lovelace/})
    expect(option).toHaveTextContent('Ada Lovelace')
    expect(chipLabelsOf(option)).toEqual([])
  })
})

// @vitest-environment happy-dom

import { useState, type ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickFind, QuickFindList, type QuickFindListGroup } from '../QuickFind.tsx'

const scrollIntoView = vi.fn()

afterEach(() => {
  cleanup()
  scrollIntoView.mockClear()
})

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  })
})

describe('QuickFind mount', () => {
  it('stays inert while closed so startup does not resolve dialog state', () => {
    const {container} = render(<QuickFind/>)

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('dialog', {name: 'Quick find'})).not.toBeInTheDocument()
  })
})

const groupedItems: QuickFindListGroup[] = [
  {
    heading: 'Recent',
    items: [{
      key: 'recent:alpha',
      value: 'recent:alpha',
      children: <span>Recent Alpha</span>,
    }],
  },
  {
    heading: 'Pages',
    items: [{
      key: 'page:project-alpha',
      value: 'page:project-alpha:Project Alpha',
      children: <span>Project Alpha</span>,
    }],
  },
  {
    heading: 'Blocks',
    items: [{
      key: 'block:sync',
      value: 'block:sync',
      children: <span>Sync block</span>,
    }],
  },
]

function ControlledQuickFindList({
  groups,
  initialQuery = '',
  initialValue = '',
  onSelect = () => undefined,
  onItemClickCapture,
}: {
  groups: QuickFindListGroup[]
  initialQuery?: string
  initialValue?: string
  onSelect?: (value: string) => void
  onItemClickCapture?: ComponentProps<typeof QuickFindList>['onItemClickCapture']
}) {
  const [query, setQuery] = useState(initialQuery)
  const [value, setValue] = useState(initialValue)

  return (
    <QuickFindList
      emptyMessage={query.trim() ? 'No results.' : 'Type to search.'}
      groups={groups}
      onItemClickCapture={onItemClickCapture}
      onQueryChange={nextQuery => {
        setQuery(nextQuery)
        setValue('')
      }}
      onSelect={onSelect}
      onValueChange={setValue}
      query={query}
      value={value}
    />
  )
}

describe('QuickFindList', () => {
  it('moves keyboard selection through items across groups', () => {
    const onSelect = vi.fn()
    render(
      <ControlledQuickFindList
        groups={groupedItems}
        initialValue="recent:alpha"
        onSelect={onSelect}
      />,
    )

    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, {key: 'ArrowDown'})
    expect(screen.getByRole('option', {name: 'Project Alpha'})).toHaveAttribute(
      'aria-selected',
      'true',
    )

    fireEvent.keyDown(input, {key: 'End'})
    expect(screen.getByRole('option', {name: 'Sync block'})).toHaveAttribute(
      'aria-selected',
      'true',
    )

    fireEvent.keyDown(input, {key: 'Home'})
    const firstOption = screen.getByRole('option', {name: 'Recent Alpha'})
    expect(firstOption).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(input, {key: 'Enter'})
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('recent:alpha')
  })

  it('selects clicked items after click capture records modifiers', () => {
    const calls: string[] = []
    render(
      <ControlledQuickFindList
        groups={groupedItems}
        initialValue="recent:alpha"
        onItemClickCapture={() => calls.push('capture')}
        onSelect={selectedValue => calls.push(`select:${selectedValue}`)}
      />,
    )

    fireEvent.click(screen.getByRole('option', {name: 'Project Alpha'}))

    expect(calls).toEqual([
      'capture',
      'select:page:project-alpha:Project Alpha',
    ])
  })

  it('moves selection on pointer hover', () => {
    render(
      <ControlledQuickFindList
        groups={groupedItems}
        initialValue="recent:alpha"
      />,
    )

    const input = screen.getByRole('combobox')
    const pageOption = screen.getByRole('option', {name: 'Project Alpha'})

    fireEvent.pointerMove(pageOption)

    expect(pageOption).toHaveAttribute('aria-selected', 'true')
    expect(input).toHaveAttribute('aria-activedescendant', pageOption.id)
  })

  it('renders the idle empty state when there is no query and no items', () => {
    render(<ControlledQuickFindList groups={[]}/>)

    expect(screen.getByText('Type to search.')).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-autocomplete', 'list')
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-label', 'Suggestions')
  })

  it('updates rendered results and selection when the query changes', async () => {
    function DynamicResults() {
      const [query, setQuery] = useState('')
      const [value, setValue] = useState('')
      const groups: QuickFindListGroup[] = query.trim()
        ? [{
          heading: 'Pages',
          items: [{
            key: 'page:sync',
            value: 'page:sync:Sync page',
            children: <span>Sync page</span>,
          }],
        }]
        : []

      return (
        <QuickFindList
          emptyMessage={query.trim() ? 'No results.' : 'Type to search.'}
          groups={groups}
          onQueryChange={nextQuery => {
            setQuery(nextQuery)
            setValue('')
          }}
          onSelect={() => undefined}
          onValueChange={setValue}
          query={query}
          value={value}
        />
      )
    }

    render(<DynamicResults/>)

    const input = screen.getByRole('combobox')
    expect(screen.getByText('Type to search.')).toBeInTheDocument()

    fireEvent.change(input, {target: {value: 'sync'}})

    const option = screen.getByRole('option', {name: 'Sync page'})
    expect(option).toHaveAttribute('data-value', 'page:sync:Sync page')
    await waitFor(() => {
      expect(option).toHaveAttribute('aria-selected', 'true')
      expect(input).toHaveAttribute('aria-activedescendant', option.id)
    })
  })
})

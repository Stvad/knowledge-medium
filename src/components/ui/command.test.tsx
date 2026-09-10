// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './command.tsx'

// cmdk's list observes its own size and scrolls the active row into view —
// happy-dom has neither API.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never

let scrolledTo: Element[] = []

beforeEach(() => {
  scrolledTo = []
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolledTo.push(this)
  }
})

afterEach(cleanup)

const selectedRow = () => document.querySelector('[cmdk-item][aria-selected="true"]')

const renderRows = (values: string[]) =>
  render(
    <Command>
      <CommandInput/>
      <CommandList>
        <CommandGroup heading="Group">
          {values.map(value => <CommandItem key={value} value={value}>{value}</CommandItem>)}
        </CommandGroup>
      </CommandList>
    </Command>,
  )

describe('CommandList', () => {
  // "b" scores an exact match higher than a substring one, so the query
  // re-sorts the rows and moves the selection off the row that held it —
  // the shape where cmdk scrolled to the PREVIOUSLY selected row and left
  // the top matches scrolled past. Both rows stay mounted, so the stale
  // row is still there to be scrolled to.
  it('scrolls to the row selected AFTER a query re-sorts the list', async () => {
    renderRows(['ab', 'b'])
    await waitFor(() => expect(selectedRow()?.getAttribute('data-value')).toBe('ab'))

    scrolledTo = []
    fireEvent.change(document.querySelector('[cmdk-input]')!, {target: {value: 'b'}})

    await waitFor(() => expect(selectedRow()?.getAttribute('data-value')).toBe('b'))
    expect(scrolledTo.at(-1)).toBe(selectedRow())
  })

  // A query that leaves the same row selected changes no value, so cmdk
  // scrolls nothing at all — and a list the user had scrolled stays where
  // it was, with the selected top match above the fold.
  it('scrolls on a query change that leaves the selection alone', async () => {
    renderRows(['alpha', 'beta'])
    await waitFor(() => expect(selectedRow()?.getAttribute('data-value')).toBe('alpha'))

    scrolledTo = []
    fireEvent.change(document.querySelector('[cmdk-input]')!, {target: {value: 'a'}})

    await waitFor(() => expect(scrolledTo.at(-1)).toBe(selectedRow()))
    expect(selectedRow()?.getAttribute('data-value')).toBe('alpha')
  })

  // cmdk suppresses its own scroll for pointer-driven selection, so a row
  // half off the edge does not slide out from under the cursor. Correcting
  // every selection change would undo that; the correction is armed by a
  // query change alone.
  it('leaves pointer hover alone', async () => {
    renderRows(['alpha', 'beta'])
    await waitFor(() => expect(selectedRow()?.getAttribute('data-value')).toBe('alpha'))

    scrolledTo = []
    fireEvent.pointerMove(document.querySelector('[cmdk-item][data-value="beta"]')!)

    // Wait for the hover to actually move the selection — asserting on the
    // absence of a scroll before that would pass with the fix reverted.
    await waitFor(() => expect(selectedRow()?.getAttribute('data-value')).toBe('beta'))
    expect(scrolledTo).toEqual([])
  })
})

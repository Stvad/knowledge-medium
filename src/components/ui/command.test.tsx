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

describe('CommandList', () => {
  // "b" scores an exact match higher than a substring one, so the query
  // re-sorts the rows and moves the selection off the row that held it —
  // the shape where cmdk scrolled to the PREVIOUSLY selected row and left
  // the top matches scrolled past. Both rows stay mounted, so the stale
  // row is still there to be scrolled to.
  it('scrolls to the row selected AFTER a query re-sorts the list', async () => {
    render(
      <Command>
        <CommandInput/>
        <CommandList>
          <CommandGroup heading="Group">
            <CommandItem value="ab">ab</CommandItem>
            <CommandItem value="b">b</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>,
    )
    await waitFor(() => expect(selectedRow()?.getAttribute('data-value')).toBe('ab'))

    scrolledTo = []
    fireEvent.change(document.querySelector('[cmdk-input]')!, {target: {value: 'b'}})

    await waitFor(() => expect(selectedRow()?.getAttribute('data-value')).toBe('b'))
    expect(scrolledTo.at(-1)).toBe(selectedRow())
  })
})

/**
 * Component tests for the System Plugins settings tree.
 *
 * The component is presentational: it takes a discovered tree + the
 * current overrides + an onToggle callback and renders nested
 * checkboxes. Persistence (writing the overrides map to the System
 * Plugins block) is the parent's responsibility — these tests stub it
 * with a vi.fn so the contract between component and host is testable
 * in isolation.
 */
import {render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import type {ToggleNode} from '@/extensions/discoverToggleTree.ts'
import {systemToggle, type Overrides} from '@/extensions/togglable.ts'
import {SystemPluginsSettings} from '@/plugins/system-plugins/SystemPluginsSettings.tsx'

const node = (
  id: string,
  name: string,
  opts: {
    essential?: boolean
    defaultEnabled?: boolean
    description?: string
    children?: ToggleNode[]
  } = {},
): ToggleNode => ({
  handle: systemToggle({
    id,
    name,
    description: opts.description,
    essential: opts.essential,
    defaultEnabled: opts.defaultEnabled,
  }),
  children: opts.children ?? [],
})

describe('SystemPluginsSettings', () => {
  it('renders a row per handle with its display name', () => {
    const tree = [node('system:a', 'Alpha'), node('system:b', 'Beta')]

    render(
      <SystemPluginsSettings
        tree={tree}
        overrides={new Map()}
        onToggle={vi.fn()}
      />,
    )

    expect(screen.getByRole('checkbox', {name: /alpha/i})).toBeInTheDocument()
    expect(screen.getByRole('checkbox', {name: /beta/i})).toBeInTheDocument()
  })

  it('checkbox state reflects the resolved enabled-ness', () => {
    const tree = [
      node('system:enabled', 'Enabled'),
      node('system:disabled-override', 'DisabledByOverride'),
      node('system:opt-in', 'OptIn', {defaultEnabled: false}),
    ]
    const overrides: Overrides = new Map([['system:disabled-override', false]])

    render(
      <SystemPluginsSettings tree={tree} overrides={overrides} onToggle={vi.fn()} />,
    )

    expect(screen.getByRole('checkbox', {name: /^enabled$/i}))
      .toHaveAttribute('data-state', 'checked')
    expect(screen.getByRole('checkbox', {name: /disabledbyoverride/i}))
      .toHaveAttribute('data-state', 'unchecked')
    expect(screen.getByRole('checkbox', {name: /optin/i}))
      .toHaveAttribute('data-state', 'unchecked')
  })

  it('essentials render as checked and disabled (cannot be flipped)', async () => {
    const onToggle = vi.fn()
    const tree = [node('system:core', 'Core', {essential: true})]

    render(
      <SystemPluginsSettings tree={tree} overrides={new Map()} onToggle={onToggle} />,
    )

    const checkbox = screen.getByRole('checkbox', {name: /core/i})
    expect(checkbox).toHaveAttribute('data-state', 'checked')
    expect(checkbox).toBeDisabled()

    await userEvent.click(checkbox)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('clicking a non-essential checkbox calls onToggle with the new state', async () => {
    const onToggle = vi.fn()
    const handleA = systemToggle({id: 'system:a', name: 'A'})
    const tree: ToggleNode[] = [{handle: handleA, children: []}]

    render(
      <SystemPluginsSettings tree={tree} overrides={new Map()} onToggle={onToggle} />,
    )

    await userEvent.click(screen.getByRole('checkbox', {name: /^a$/i}))

    expect(onToggle).toHaveBeenCalledTimes(1)
    const [calledHandle, calledNext] = onToggle.mock.calls[0]
    expect(calledHandle).toBe(handleA)
    expect(calledNext).toBe(false) // was on by default, click → off
  })

  it('clicking a disabled non-essential calls onToggle(true)', async () => {
    const onToggle = vi.fn()
    const handle = systemToggle({id: 'system:a', name: 'A'})
    const tree: ToggleNode[] = [{handle, children: []}]
    const overrides: Overrides = new Map([['system:a', false]])

    render(
      <SystemPluginsSettings tree={tree} overrides={overrides} onToggle={onToggle} />,
    )

    await userEvent.click(screen.getByRole('checkbox', {name: /^a$/i}))

    expect(onToggle).toHaveBeenCalledWith(handle, true)
  })

  it('renders nested children under their parent', () => {
    const tree = [
      node('system:outer', 'Outer', {
        children: [
          node('system:inner-a', 'InnerA'),
          node('system:inner-b', 'InnerB'),
        ],
      }),
    ]

    render(
      <SystemPluginsSettings tree={tree} overrides={new Map()} onToggle={vi.fn()} />,
    )

    // All three checkboxes should be in the DOM; nesting is asserted
    // by treeitem aria role + level (set by the component).
    expect(screen.getAllByRole('treeitem')).toHaveLength(3)
    const inner = screen.getByRole('treeitem', {name: /innera/i})
    expect(inner).toHaveAttribute('aria-level', '2')
    const outer = screen.getByRole('treeitem', {name: /^outer$/i})
    expect(outer).toHaveAttribute('aria-level', '1')
  })

  it('shows description text when present', () => {
    const tree = [
      node('system:a', 'WithDesc', {description: 'A description of the plugin'}),
    ]

    render(
      <SystemPluginsSettings tree={tree} overrides={new Map()} onToggle={vi.fn()} />,
    )

    expect(screen.getByText('A description of the plugin')).toBeInTheDocument()
  })

  it('renders an empty-state message when the tree is empty', () => {
    render(
      <SystemPluginsSettings tree={[]} overrides={new Map()} onToggle={vi.fn()} />,
    )

    expect(screen.getByText(/no plugins/i)).toBeInTheDocument()
  })
})

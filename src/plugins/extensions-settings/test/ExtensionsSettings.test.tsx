/**
 * Component tests for the Extensions settings tree.
 *
 * The component is presentational: it takes a discovered tree + the
 * current overrides + an onToggle callback and renders nested
 * checkboxes. Persistence (writing the overrides map to the Extensions
 * block) is the parent's responsibility — these tests stub it
 * with a vi.fn so the contract between component and host is testable
 * in isolation.
 */
import {render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import type {ToggleNode} from '@/extensions/discoverToggleTree.ts'
import {makeBlockData} from '@/data/test/factories.ts'
import {
  systemToggle,
  userExtensionToggle,
  type Overrides,
} from '@/extensions/togglable.ts'
import {ExtensionsSettings} from '@/plugins/extensions-settings/ExtensionsSettings.tsx'

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

const userNode = (
  blockId: string,
  hintsName?: string,
): ToggleNode => ({
  handle: userExtensionToggle(
    makeBlockData({id: blockId, workspaceId: 'ws'}),
    hintsName ? {name: hintsName} : undefined,
  ),
  children: [],
})

describe('ExtensionsSettings', () => {
  it('renders a row per handle with its display name', () => {
    const tree = [node('system:a', 'Alpha'), node('system:b', 'Beta')]

    render(
      <ExtensionsSettings
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
      <ExtensionsSettings tree={tree} overrides={overrides} onToggle={vi.fn()} />,
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
      <ExtensionsSettings tree={tree} overrides={new Map()} onToggle={onToggle} />,
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
      <ExtensionsSettings tree={tree} overrides={new Map()} onToggle={onToggle} />,
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
      <ExtensionsSettings tree={tree} overrides={overrides} onToggle={onToggle} />,
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
      <ExtensionsSettings tree={tree} overrides={new Map()} onToggle={vi.fn()} />,
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
      <ExtensionsSettings tree={tree} overrides={new Map()} onToggle={vi.fn()} />,
    )

    expect(screen.getByText('A description of the plugin')).toBeInTheDocument()
  })

  it('renders an empty-state message when the tree is empty', () => {
    render(
      <ExtensionsSettings tree={[]} overrides={new Map()} onToggle={vi.fn()} />,
    )

    expect(screen.getByText(/no extensions/i)).toBeInTheDocument()
  })

  it('groups essentials at the top, then non-essentials below', () => {
    // Catalog ordering mixes essentials and non-essentials freely;
    // the settings UI should hoist essentials so they're not scattered.
    // Within each group, alphabetical (see next test).
    const tree = [
      node('system:opt-a', 'OptA'),
      node('system:ess-1', 'Ess1', {essential: true}),
      node('system:opt-b', 'OptB'),
      node('system:ess-2', 'Ess2', {essential: true}),
      node('system:opt-c', 'OptC'),
    ]

    render(
      <ExtensionsSettings tree={tree} overrides={new Map()} onToggle={vi.fn()} />,
    )

    const rows = screen.getAllByRole('treeitem')
    const orderedNames = rows.map(r => r.getAttribute('aria-label'))
    expect(orderedNames).toEqual(['Ess1', 'Ess2', 'OptA', 'OptB', 'OptC'])
  })

  it('sorts alphabetically within each (essential / non-essential) group', () => {
    // Mixed-case + accent to confirm locale-aware compare.
    const tree = [
      node('id:c', 'Charlie'),
      node('id:a', 'alpha'),
      node('id:b', 'Bravo'),
      node('id:ess-z', 'Zulu', {essential: true}),
      node('id:ess-a', 'Alpha-E', {essential: true}),
    ]

    render(
      <ExtensionsSettings tree={tree} overrides={new Map()} onToggle={vi.fn()} />,
    )

    const rows = screen.getAllByRole('treeitem')
    const orderedNames = rows.map(r => r.getAttribute('aria-label'))
    // Essentials first, then non-essentials. Within each group:
    // case-insensitive alphabetical.
    expect(orderedNames).toEqual(['Alpha-E', 'Zulu', 'alpha', 'Bravo', 'Charlie'])
  })

  it('renders separate built-in and user extension sections when both are present', () => {
    const tree = [
      node('system:a', 'Alpha'),
      userNode('block-uuid-1', 'Custom Editor'),
      node('system:b', 'Bravo'),
      userNode('block-uuid-2', 'Tag Buddy'),
    ]

    render(
      <ExtensionsSettings tree={tree} overrides={new Map()} onToggle={vi.fn()} />,
    )

    // Both section headers present.
    expect(screen.getByText(/built-in extensions/i)).toBeInTheDocument()
    expect(screen.getByText(/user extensions/i)).toBeInTheDocument()

    // System rows come before user rows in DOM order.
    const rows = screen.getAllByRole('treeitem')
    const labels = rows.map(r => r.getAttribute('aria-label'))
    expect(labels.indexOf('Alpha')).toBeLessThan(labels.indexOf('Custom Editor'))
    expect(labels.indexOf('Bravo')).toBeLessThan(labels.indexOf('Tag Buddy'))
    // Within each section, alphabetical.
    expect(labels.indexOf('Alpha')).toBeLessThan(labels.indexOf('Bravo'))
    expect(labels.indexOf('Custom Editor')).toBeLessThan(labels.indexOf('Tag Buddy'))
  })

  it('links user extension names to their definition blocks without toggling them', async () => {
    const onToggle = vi.fn()
    const tree = [userNode('block-uuid-1', 'Custom Editor')]

    render(
      <ExtensionsSettings
        tree={tree}
        overrides={new Map()}
        onToggle={onToggle}
        workspaceId="ws"
      />,
    )

    const link = screen.getByRole('link', {name: /custom editor/i})
    expect(link).toHaveAttribute('href', '#ws/block-uuid-1')

    await userEvent.click(link)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('omits the "User extensions" header when no user-kind handles exist', () => {
    const tree = [node('system:a', 'Alpha'), node('system:b', 'Bravo')]

    render(
      <ExtensionsSettings tree={tree} overrides={new Map()} onToggle={vi.fn()} />,
    )

    expect(screen.queryByText(/user extensions/i)).not.toBeInTheDocument()
  })

  it('omits the built-in extensions header when only user extensions exist', () => {
    const tree = [userNode('block-uuid-only', 'Just Mine')]

    render(
      <ExtensionsSettings tree={tree} overrides={new Map()} onToggle={vi.fn()} />,
    )

    expect(screen.queryByText(/built-in extensions/i)).not.toBeInTheDocument()
    expect(screen.getByText(/user extensions/i)).toBeInTheDocument()
  })

  it('groups essentials first within nested children too', () => {
    const tree = [
      node('system:parent', 'Parent', {
        children: [
          node('system:child-opt', 'ChildOpt'),
          node('system:child-ess', 'ChildEss', {essential: true}),
        ],
      }),
    ]

    render(
      <ExtensionsSettings tree={tree} overrides={new Map()} onToggle={vi.fn()} />,
    )

    const rows = screen.getAllByRole('treeitem')
    const orderedNames = rows.map(r => r.getAttribute('aria-label'))
    expect(orderedNames).toEqual(['Parent', 'ChildEss', 'ChildOpt'])
  })
})

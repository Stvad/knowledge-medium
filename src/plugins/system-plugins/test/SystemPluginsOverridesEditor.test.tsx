/**
 * Tests the editor wrapper that bridges the property-panel
 * `onChange(next: Overrides)` contract to the toggle tree's
 * `onToggle(handle, nextState)` semantics.
 *
 * The pieces underneath (tree discovery + checkbox rendering +
 * applyToggle math) are unit-tested independently; here we just
 * confirm the bridge:
 *   - useToggleTree returns are forwarded to <SystemPluginsSettings>
 *   - toggling a row calls onChange with applyToggle(value, handle, next)
 *   - loading state renders a placeholder
 */
import {render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import type {Block} from '@/data/block'
import type {PropertyEditorProps} from '@/data/api'
import {systemToggle, type Overrides} from '@/extensions/togglable.ts'
import type {ToggleNode} from '@/extensions/discoverToggleTree.ts'
import {SystemPluginsOverridesEditor} from '@/plugins/system-plugins/SystemPluginsOverridesEditor.tsx'

// Stub useToggleTree at the module boundary so we can drive the
// editor without standing up a real Repo.
const useToggleTreeMock = vi.hoisted(() => vi.fn())
vi.mock('@/plugins/system-plugins/useToggleTree.ts', () => ({
  useToggleTree: useToggleTreeMock,
}))

const handleA = systemToggle({id: 'system:a', name: 'Alpha'})

const renderEditor = (props: Partial<PropertyEditorProps<Overrides>> = {}) => {
  const defaults: PropertyEditorProps<Overrides> = {
    value: new Map(),
    onChange: vi.fn(),
    block: {} as Block,
  }
  return render(<SystemPluginsOverridesEditor {...defaults} {...props} />)
}

describe('SystemPluginsOverridesEditor', () => {
  it('renders a loading placeholder while the tree resolves', () => {
    useToggleTreeMock.mockReturnValue({tree: [], loading: true})
    renderEditor()
    expect(screen.getByText(/loading plugins/i)).toBeInTheDocument()
  })

  it('renders the toggle tree once useToggleTree settles', () => {
    const tree: ToggleNode[] = [{handle: handleA, children: []}]
    useToggleTreeMock.mockReturnValue({tree, loading: false})

    renderEditor({value: new Map()})

    expect(screen.getByRole('checkbox', {name: /alpha/i})).toBeInTheDocument()
  })

  it('forwards onToggle through applyToggle into the property-panel onChange', async () => {
    const tree: ToggleNode[] = [{handle: handleA, children: []}]
    useToggleTreeMock.mockReturnValue({tree, loading: false})
    const onChange = vi.fn()

    renderEditor({value: new Map(), onChange})

    // handleA defaults to enabled; clicking flips it off. applyToggle
    // records that as `{[id]: false}`.
    await userEvent.click(screen.getByRole('checkbox', {name: /alpha/i}))

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as Overrides
    expect(next.get('system:a')).toBe(false)
  })

  it('flipping a disabled row back on removes the override entry', async () => {
    const tree: ToggleNode[] = [{handle: handleA, children: []}]
    useToggleTreeMock.mockReturnValue({tree, loading: false})
    const onChange = vi.fn()
    const value: Overrides = new Map([['system:a', false]])

    renderEditor({value, onChange})

    await userEvent.click(screen.getByRole('checkbox', {name: /alpha/i}))

    const next = onChange.mock.calls[0][0] as Overrides
    expect(next.has('system:a')).toBe(false)
  })
})

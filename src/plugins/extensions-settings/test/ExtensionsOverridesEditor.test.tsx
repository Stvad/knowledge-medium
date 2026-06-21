/**
 * Tests the editor wrapper that bridges the property-panel
 * `onChange(next: Overrides)` contract to the toggle tree's
 * `onToggle(handle, nextState)` semantics.
 *
 * The pieces underneath (tree discovery + checkbox rendering +
 * applyToggle math) are unit-tested independently; here we just
 * confirm the bridge:
 *   - useToggleTree returns are forwarded to <ExtensionsSettings>
 *   - toggling a row calls onChange with applyToggle(value, handle, next)
 *   - loading state renders a placeholder
 */
import {render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {Block} from '@/data/block'
import type {PropertyEditorProps} from '@/data/api'
import {makeBlockData} from '@/data/test/factories.js'
import {systemToggle, type Overrides} from '@/facets/togglable.js'
import {userExtensionToggle} from '@/extensions/extensionToggles.js'
import type {ToggleNode} from '@/facets/discoverToggleTree.js'
import {ExtensionsOverridesEditor} from '@/plugins/extensions-settings/ExtensionsOverridesEditor.js'

// Stub useToggleTree at the module boundary so we can drive the
// editor without standing up a real Repo.
const useToggleTreeMock = vi.hoisted(() => vi.fn())
vi.mock('@/plugins/extensions-settings/useToggleTree.ts', () => ({
  useToggleTree: useToggleTreeMock,
}))

// The editor now reads the repo (to load a user extension's source for
// approval) — stub it.
const mockRepo = vi.hoisted(() => ({load: vi.fn()}))
vi.mock('@/context/repo.js', () => ({
  useRepo: () => mockRepo,
}))

// Spy the device-local trust calls without touching IndexedDB/Babel.
const approveSpy = vi.hoisted(() => vi.fn())
const revokeSpy = vi.hoisted(() => vi.fn())
const readApprovalSpy = vi.hoisted(() => vi.fn())
vi.mock('@/extensions/compileExtensionModule.js', async (importActual) => ({
  ...(await importActual<object>()),
  approveExtension: approveSpy,
  revokeExtensionApproval: revokeSpy,
  readApproval: readApprovalSpy,
}))

const handleA = systemToggle({id: 'system:a', name: 'Alpha'})
const userBlock = makeBlockData({id: 'block-user', workspaceId: 'ws', content: 'SRC'})
const userHandle = userExtensionToggle(userBlock)

const renderEditor = (props: Partial<PropertyEditorProps<Overrides>> = {}) => {
  const defaults: PropertyEditorProps<Overrides> = {
    value: new Map(),
    onChange: vi.fn(),
    block: {} as Block,
  }
  return render(<ExtensionsOverridesEditor {...defaults} {...props} />)
}

describe('ExtensionsOverridesEditor', () => {
  beforeEach(() => {
    approveSpy.mockClear()
    revokeSpy.mockClear()
    readApprovalSpy.mockReset()
    readApprovalSpy.mockResolvedValue(undefined)
    mockRepo.load.mockReset()
  })

  it('renders a loading placeholder while the tree resolves', () => {
    useToggleTreeMock.mockReturnValue({tree: [], loading: true})
    renderEditor()
    expect(screen.getByText(/loading extensions/i)).toBeInTheDocument()
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

  it('first-time enable of a user extension approves its live source, then sets intent', async () => {
    const tree: ToggleNode[] = [{handle: userHandle, children: []}]
    useToggleTreeMock.mockReturnValue({tree, loading: false})
    readApprovalSpy.mockResolvedValue(undefined) // not yet approved here
    mockRepo.load.mockResolvedValue(userBlock)
    const onChange = vi.fn()

    renderEditor({value: new Map(), onChange})

    // User toggles default off → the row is unchecked → clicking enables.
    await userEvent.click(screen.getByRole('checkbox', {name: /block-user|extension/i}))

    await vi.waitFor(() => expect(approveSpy).toHaveBeenCalledWith('block-user', 'SRC'))
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    const next = onChange.mock.calls[0][0] as Overrides
    expect(next.get('block-user')).toBe(true)
    expect(revokeSpy).not.toHaveBeenCalled()
  })

  it('enabling an already-approved user extension keeps the pin (no re-approve)', async () => {
    const tree: ToggleNode[] = [{handle: userHandle, children: []}]
    useToggleTreeMock.mockReturnValue({tree, loading: false})
    // Already approved here (e.g. re-enable after a disable).
    readApprovalSpy.mockResolvedValue({
      sourceHash: 'h',
      approvedSource: 'SRC',
      compiled: 'SRC',
      compilerVersion: '1',
      approvedAt: 0,
    })
    const onChange = vi.fn()

    renderEditor({value: new Map(), onChange})

    await userEvent.click(screen.getByRole('checkbox', {name: /block-user|extension/i}))

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    const next = onChange.mock.calls[0][0] as Overrides
    expect(next.get('block-user')).toBe(true)
    // The existing pin is kept — a drifted source would show as
    // update-available rather than being silently re-approved here.
    expect(approveSpy).not.toHaveBeenCalled()
  })

  it('disabling a user extension only clears intent and keeps the local approval', async () => {
    const tree: ToggleNode[] = [{handle: userHandle, children: []}]
    useToggleTreeMock.mockReturnValue({tree, loading: false})
    const onChange = vi.fn()
    const value: Overrides = new Map([['block-user', true]])

    renderEditor({value, onChange})

    await userEvent.click(screen.getByRole('checkbox', {name: /block-user|extension/i}))

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    const next = onChange.mock.calls[0][0] as Overrides
    // Disabling a user extension (default-off) removes the intent entry…
    expect(next.has('block-user')).toBe(false)
    // …but never revokes or re-approves the device-local trust grant.
    expect(revokeSpy).not.toHaveBeenCalled()
    expect(approveSpy).not.toHaveBeenCalled()
  })
})

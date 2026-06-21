/**
 * Tests the editor wrapper that bridges the toggle tree's
 * `onToggle(handle, nextState)` semantics to a property write.
 *
 * The pieces underneath (tree discovery + checkbox rendering +
 * applyToggle math) are unit-tested independently; here we confirm the
 * bridge:
 *   - useToggleTree returns are forwarded to <ExtensionsSettings>
 *   - toggling a row writes the intent map via `block.set(prop, updater)`
 *     (a read-modify-write, so overlapping toggles don't clobber), with
 *     the updater applying `applyToggle`
 *   - a user-extension enable approves first and skips the write on failure
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

// The editor reads the repo (to load a user extension's source for
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

// Spy the toast so a failed approval surfaces an assertable error instead
// of rendering a real sonner toast.
const showErrorSpy = vi.hoisted(() => vi.fn())
vi.mock('@/utils/toast.js', () => ({showError: showErrorSpy}))

const handleA = systemToggle({id: 'system:a', name: 'Alpha'})
const userBlock = makeBlockData({id: 'block-user', workspaceId: 'ws', content: 'SRC'})
const userHandle = userExtensionToggle(userBlock)

// The editor writes intent via `block.set(prop, updater)`. The spy
// captures the updater; `appliedOverrides` runs it against a supplied
// "current" map to assert the resulting intent.
const blockSet = vi.hoisted(() => vi.fn())
const appliedOverrides = (current: Overrides = new Map()): Overrides => {
  const updater = blockSet.mock.calls[0][1] as (c: Overrides | undefined) => Overrides
  return updater(current)
}

const renderEditor = (props: Partial<PropertyEditorProps<Overrides>> = {}) => {
  const defaults: PropertyEditorProps<Overrides> = {
    value: new Map(),
    onChange: vi.fn(),
    block: {set: blockSet} as unknown as Block,
  }
  return render(<ExtensionsOverridesEditor {...defaults} {...props} />)
}

describe('ExtensionsOverridesEditor', () => {
  beforeEach(() => {
    approveSpy.mockReset()
    revokeSpy.mockClear()
    showErrorSpy.mockClear()
    blockSet.mockReset()
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

  it('writes intent via a block.set read-modify-write applying applyToggle', async () => {
    const tree: ToggleNode[] = [{handle: handleA, children: []}]
    useToggleTreeMock.mockReturnValue({tree, loading: false})

    renderEditor({value: new Map()})

    // handleA defaults to enabled; clicking flips it off. The updater
    // records that as `{[id]: false}` against the current map.
    await userEvent.click(screen.getByRole('checkbox', {name: /alpha/i}))

    await vi.waitFor(() => expect(blockSet).toHaveBeenCalledTimes(1))
    expect(appliedOverrides(new Map()).get('system:a')).toBe(false)
  })

  it('flipping a disabled row back on removes the override entry', async () => {
    const tree: ToggleNode[] = [{handle: handleA, children: []}]
    useToggleTreeMock.mockReturnValue({tree, loading: false})
    const value: Overrides = new Map([['system:a', false]])

    renderEditor({value})

    await userEvent.click(screen.getByRole('checkbox', {name: /alpha/i}))

    await vi.waitFor(() => expect(blockSet).toHaveBeenCalledTimes(1))
    // Re-enabling to the manifest default drops the entry entirely.
    expect(appliedOverrides(value).has('system:a')).toBe(false)
  })

  it('first-time enable of a user extension approves its live source, then sets intent', async () => {
    const tree: ToggleNode[] = [{handle: userHandle, children: []}]
    useToggleTreeMock.mockReturnValue({tree, loading: false})
    readApprovalSpy.mockResolvedValue(undefined) // not yet approved here
    mockRepo.load.mockResolvedValue(userBlock)

    renderEditor({value: new Map()})

    // User toggles default off → the row is unchecked → clicking enables.
    await userEvent.click(screen.getByRole('checkbox', {name: /block-user|extension/i}))

    await vi.waitFor(() => expect(approveSpy).toHaveBeenCalledWith('block-user', 'SRC'))
    await vi.waitFor(() => expect(blockSet).toHaveBeenCalledTimes(1))
    expect(appliedOverrides(new Map()).get('block-user')).toBe(true)
    expect(revokeSpy).not.toHaveBeenCalled()
  })

  it('surfaces an error and does NOT set intent when the approval fails', async () => {
    const tree: ToggleNode[] = [{handle: userHandle, children: []}]
    useToggleTreeMock.mockReturnValue({tree, loading: false})
    readApprovalSpy.mockResolvedValue(undefined) // not yet approved here
    mockRepo.load.mockResolvedValue(userBlock)
    approveSpy.mockRejectedValue(new Error('write boom')) // trust persist fails

    renderEditor({value: new Map()})

    await userEvent.click(screen.getByRole('checkbox', {name: /block-user|extension/i}))

    await vi.waitFor(() => expect(showErrorSpy).toHaveBeenCalledTimes(1))
    // Intent must NOT be written when trust couldn't be established —
    // otherwise the row loops on needs-approval with nothing running.
    expect(blockSet).not.toHaveBeenCalled()
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

    renderEditor({value: new Map()})

    await userEvent.click(screen.getByRole('checkbox', {name: /block-user|extension/i}))

    await vi.waitFor(() => expect(blockSet).toHaveBeenCalledTimes(1))
    expect(appliedOverrides(new Map()).get('block-user')).toBe(true)
    // The existing pin is kept — a drifted source would show as
    // update-available rather than being silently re-approved here.
    expect(approveSpy).not.toHaveBeenCalled()
  })

  it('disabling a user extension only clears intent and keeps the local approval', async () => {
    const tree: ToggleNode[] = [{handle: userHandle, children: []}]
    useToggleTreeMock.mockReturnValue({tree, loading: false})
    const value: Overrides = new Map([['block-user', true]])

    renderEditor({value})

    await userEvent.click(screen.getByRole('checkbox', {name: /block-user|extension/i}))

    await vi.waitFor(() => expect(blockSet).toHaveBeenCalledTimes(1))
    // Disabling a user extension (default-off) removes the intent entry…
    expect(appliedOverrides(value).has('block-user')).toBe(false)
    // …but never revokes or re-approves the device-local trust grant.
    expect(revokeSpy).not.toHaveBeenCalled()
    expect(approveSpy).not.toHaveBeenCalled()
  })
})

// @vitest-environment jsdom
/**
 * Integration test for the global prompt surface — the reconciliation the
 * reported bug lived in: enabling/dismissing one extension's prompt must act
 * on THAT extension only, and a dismissal must persist.
 *
 * We drive the real `ExtensionPromptSurface` mount against the real approval
 * store (via context) and the real dismissal singleton, mocking only the
 * leaf effects (toast rendering, approval write, runtime refresh) so we can
 * observe which extension each call targets.
 */
import {render, waitFor} from '@testing-library/react'
import {act} from 'react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  ExtensionApprovalStatusProvider,
  ExtensionApprovalStatusStore,
} from '@/extensions/extensionApprovalStatus.js'
import {extensionPromptDismissals} from '@/extensions/extensionPromptDismissals.js'
import {ExtensionPromptSurface} from '@/extensions/extensionPromptMount.js'
import {extensionPromptStore} from '@/extensions/extensionPromptStore.js'
import type {ToastOptions} from '@/utils/toast.js'

const showInfo = vi.hoisted(() => vi.fn())
const dismissToast = vi.hoisted(() => vi.fn())
vi.mock('@/utils/toast.js', () => ({showInfo, dismissToast}))

const approveExtensionHere = vi.hoisted(() => vi.fn().mockResolvedValue(true))
vi.mock('@/extensions/approveExtensionHere.js', () => ({approveExtensionHere}))

const refreshAppRuntime = vi.hoisted(() => vi.fn())
vi.mock('@/facets/runtimeEvents.js', () => ({refreshAppRuntime}))

const repo = {} as never
vi.mock('@/context/repo.js', () => ({useRepo: () => repo}))

/** The options passed to the most recent showInfo for a given toast id. */
const optsFor = (blockId: string): ToastOptions => {
  const call = [...showInfo.mock.calls]
    .reverse()
    .find((c) => c[1]?.id === `ext-approval:${blockId}`)
  if (!call) throw new Error(`no toast shown for ${blockId}`)
  return call[1] as ToastOptions
}

const renderSurface = (store: ExtensionApprovalStatusStore) =>
  render(
    <ExtensionApprovalStatusProvider store={store}>
      <ExtensionPromptSurface />
    </ExtensionApprovalStatusProvider>,
  )

describe('ExtensionPromptSurface', () => {
  beforeEach(() => {
    localStorage.clear()
    extensionPromptDismissals.reloadFromStorage()
    vi.clearAllMocks()
  })
  afterEach(() => vi.restoreAllMocks())

  it('shows one keyed toast per pending extension', async () => {
    const store = new ExtensionApprovalStatusStore()
    store.report('matrix', {kind: 'needs-approval', name: 'Matrix', liveHash: 'hm'})
    store.report('readwise', {
      kind: 'update-available',
      name: 'Readwise',
      liveHash: 'hr',
      approvedHash: 'h0',
    })
    renderSurface(store)

    await waitFor(() => {
      expect(showInfo).toHaveBeenCalledWith(
        expect.stringContaining('Matrix'),
        expect.objectContaining({id: 'ext-approval:matrix'}),
      )
      expect(showInfo).toHaveBeenCalledWith(
        expect.stringContaining('Readwise'),
        expect.objectContaining({id: 'ext-approval:readwise'}),
      )
    })
    // The needs-approval primary is "Enable"; the update one is "Update".
    expect(optsFor('matrix').action?.label).toBe('Enable')
    expect(optsFor('readwise').action?.label).toBe('Update')
  })

  it('dismissing one extension hides ONLY it, and persists — the repro', async () => {
    const store = new ExtensionApprovalStatusStore()
    store.report('matrix', {kind: 'needs-approval', name: 'Matrix', liveHash: 'hm'})
    store.report('readwise', {kind: 'needs-approval', name: 'Readwise', liveHash: 'hr'})
    renderSurface(store)

    await waitFor(() => expect(showInfo).toHaveBeenCalledTimes(2))

    // Click "Dismiss" on Matrix's toast.
    act(() => optsFor('matrix').cancel?.onClick())

    // Matrix's toast is torn down; Readwise's is not.
    await waitFor(() =>
      expect(dismissToast).toHaveBeenCalledWith('ext-approval:matrix'),
    )
    expect(dismissToast).not.toHaveBeenCalledWith('ext-approval:readwise')

    // The dismissal is persisted for Matrix only (survives a reload).
    expect(extensionPromptDismissals.isDismissed('matrix', 'hm')).toBe(true)
    expect(extensionPromptDismissals.isDismissed('readwise', 'hr')).toBe(false)

    // Design C: Matrix still sits in the chip's published set (a quiet row),
    // now flagged dismissed — the toast is gone but it stays discoverable.
    const published = extensionPromptStore.getSnapshot()
    expect(published.find((p) => p.blockId === 'matrix')).toMatchObject({
      dismissed: true,
    })
    expect(published.find((p) => p.blockId === 'readwise')).toMatchObject({
      dismissed: false,
    })
  })

  it('dismisses open toasts when the surface unmounts (plugin toggled off)', async () => {
    const store = new ExtensionApprovalStatusStore()
    store.report('matrix', {kind: 'needs-approval', name: 'Matrix', liveHash: 'hm'})
    store.report('readwise', {kind: 'needs-approval', name: 'Readwise', liveHash: 'hr'})
    const {unmount} = renderSurface(store)

    await waitFor(() => expect(showInfo).toHaveBeenCalledTimes(2))

    act(() => unmount())

    // Infinite-duration toasts live in Sonner's portal, so unmount must tear
    // them down explicitly or they'd linger after the plugin is disabled.
    expect(dismissToast).toHaveBeenCalledWith('ext-approval:matrix')
    expect(dismissToast).toHaveBeenCalledWith('ext-approval:readwise')
  })

  it('Enable approves the clicked extension by its own blockId', async () => {
    const store = new ExtensionApprovalStatusStore()
    store.report('matrix', {kind: 'needs-approval', name: 'Matrix', liveHash: 'hm'})
    store.report('readwise', {kind: 'needs-approval', name: 'Readwise', liveHash: 'hr'})
    renderSurface(store)

    await waitFor(() => expect(showInfo).toHaveBeenCalledTimes(2))

    await act(async () => {
      optsFor('matrix').action?.onClick()
      await Promise.resolve()
    })

    expect(approveExtensionHere).toHaveBeenCalledWith(repo, 'matrix', 'Matrix')
    expect(approveExtensionHere).not.toHaveBeenCalledWith(
      repo,
      'readwise',
      expect.anything(),
    )
    await waitFor(() => expect(refreshAppRuntime).toHaveBeenCalledTimes(1))
  })

  it('keeps the toast (retry affordance) when the approval fails', async () => {
    approveExtensionHere.mockResolvedValueOnce(false)
    const store = new ExtensionApprovalStatusStore()
    store.report('matrix', {kind: 'needs-approval', name: 'Matrix', liveHash: 'hm'})
    renderSurface(store)

    await waitFor(() => expect(showInfo).toHaveBeenCalledTimes(1))

    // Sonner auto-dismisses the toast on action click; a failed approval must
    // re-show it (the status is unchanged, so the reconcile effect won't).
    await act(async () => {
      optsFor('matrix').action?.onClick()
      await Promise.resolve()
    })

    expect(refreshAppRuntime).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(
        showInfo.mock.calls.filter((c) => c[1]?.id === 'ext-approval:matrix'),
      ).toHaveLength(2),
    )
  })
})

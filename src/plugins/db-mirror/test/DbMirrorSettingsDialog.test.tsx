// @vitest-environment happy-dom
/**
 * The mirror settings dialog. Runs against a REAL `DbMirrorStore` instance
 * (fake-indexeddb, one fresh factory per test — same pattern as
 * `store.test.ts`) so a setting the dialog writes is verified through actual
 * persistence rather than a spy on a mocked store method. `../store.js` is
 * still `vi.mock`-ed, but only to swap the module's singleton `dbMirrorStore`
 * export for the per-test instance — every other export (`createDbMirrorStore`,
 * the defaults/bounds) passes through untouched.
 *
 * `../fileSystemAccess.js` (the picker + permission prompts) and
 * `../schedule.js` (`dbMirrorSchedule`) are mocked outright: both need a real
 * browser/user-gesture to mean anything.
 */
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DbMirrorSettingsDialog } from '../DbMirrorSettingsDialog.tsx'
import { createDbMirrorStore, DB_MIRROR_DEFAULTS, type DbMirrorStore } from '../store.js'

const USER = 'alice'

const mocks = vi.hoisted(() => ({
  chooseMirrorDirectory: vi.fn(),
  requestDirectoryPermission: vi.fn(),
  runNow: vi.fn(),
  resume: vi.fn(),
  showError: vi.fn(),
  showSuccess: vi.fn(),
  showInfo: vi.fn(),
  // Set fresh in `beforeEach` to a real store instance — the forwarding
  // functions below can't be defined until then, so they read through this.
  storeHolder: { current: undefined as unknown },
}))

vi.mock('@/context/repo.js', () => ({
  useRepo: () => ({ user: { id: USER } }),
}))

vi.mock('../fileSystemAccess.js', () => ({
  chooseMirrorDirectory: (...args: unknown[]) => mocks.chooseMirrorDirectory(...args),
  requestDirectoryPermission: (...args: unknown[]) => mocks.requestDirectoryPermission(...args),
}))

vi.mock('../schedule.js', () => ({
  dbMirrorSchedule: {
    runNow: (...args: unknown[]) => mocks.runNow(...args),
    resume: (...args: unknown[]) => mocks.resume(...args),
  },
  PERMISSION_LOST_MESSAGE: 'permission was lost; open settings to grant it again',
}))

vi.mock('@/utils/toast.js', () => ({
  showError: (...args: unknown[]) => mocks.showError(...args),
  showSuccess: (...args: unknown[]) => mocks.showSuccess(...args),
  showInfo: (...args: unknown[]) => mocks.showInfo(...args),
}))

vi.mock('../store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store.js')>()
  const store = (): DbMirrorStore => mocks.storeHolder.current as DbMirrorStore
  return {
    ...actual,
    dbMirrorStore: {
      load: (userId: string) => store().load(userId),
      updateSettings: (userId: string, patch: Parameters<DbMirrorStore['updateSettings']>[1]) =>
        store().updateSettings(userId, patch),
      setDirectory: (userId: string, directory: Parameters<DbMirrorStore['setDirectory']>[1]) =>
        store().setDirectory(userId, directory),
      recordStatus: (userId: string, patch: Parameters<DbMirrorStore['recordStatus']>[1]) =>
        store().recordStatus(userId, patch),
      getSnapshot: () => store().getSnapshot(),
      subscribe: (listener: () => void) => store().subscribe(listener),
    } satisfies DbMirrorStore,
  }
})

let store: DbMirrorStore

beforeEach(() => {
  // A clean slate for every mock: tests configure exactly the resolution they
  // need, so a leftover `mockResolvedValue` from a previous test can't leak in.
  vi.resetAllMocks()
  // A fresh IndexedDB per test, exactly like store.test.ts — the store caches
  // its connection, so a prior test's open handle would otherwise block a delete.
  globalThis.indexedDB = new IDBFactory()
  store = createDbMirrorStore()
  mocks.storeHolder.current = store
})

afterEach(() => {
  cleanup()
})

const fakeDirectory = (name: string) => ({ kind: 'directory', name } as unknown as FileSystemDirectoryHandle)

const renderDialog = () => {
  const resolve = vi.fn()
  const cancel = vi.fn()
  render(<DbMirrorSettingsDialog resolve={resolve} cancel={cancel} />)
  return { resolve, cancel }
}

const enableCheckbox = () => screen.getByRole('checkbox', { name: /mirror this device.s database/i })
const mirrorNowButton = () => screen.getByRole('button', { name: /mirror now/i })

/** Waits for the store's own `load` to have resolved and rendered, using the
 *  checkbox as the signal — it only exists once `state` is non-null. */
const waitForLoaded = async () => {
  await waitFor(() => expect(screen.queryByRole('checkbox')).toBeInTheDocument())
}

describe('DbMirrorSettingsDialog', () => {
  it('renders off with no folder chosen on a fresh profile', async () => {
    renderDialog()
    await waitForLoaded()

    expect(enableCheckbox()).not.toBeChecked()
    expect(screen.getByText(/no folder chosen/i)).toBeInTheDocument()
    expect(screen.getByText(/no copy yet/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /grant access again/i })).toBeNull()
    expect((screen.getByLabelText(/^keep$/i) as HTMLInputElement).value).toBe(
      String(DB_MIRROR_DEFAULTS.keepCount),
    )
  })

  it('turning it on with no folder opens the picker, stores the folder, enables the setting, and resumes the schedule', async () => {
    const directory = fakeDirectory('Backups')
    mocks.chooseMirrorDirectory.mockResolvedValue(directory)
    renderDialog()
    await waitForLoaded()

    await userEvent.click(enableCheckbox())

    await waitFor(() => expect(enableCheckbox()).toBeChecked())
    expect(mocks.chooseMirrorDirectory).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/backups/i)).toBeInTheDocument()
    expect(mocks.resume).toHaveBeenCalled()

    const snapshot = store.getSnapshot()
    expect(snapshot?.settings.enabled).toBe(true)
    expect(snapshot?.directory).toMatchObject({ name: 'Backups' })
  })

  it('dismissing the picker leaves the setting off and reports no error', async () => {
    mocks.chooseMirrorDirectory.mockRejectedValue(new DOMException('The user aborted a request.', 'AbortError'))
    renderDialog()
    await waitForLoaded()

    await userEvent.click(enableCheckbox())
    await waitFor(() => expect(mocks.chooseMirrorDirectory).toHaveBeenCalledTimes(1))
    // Flush the rejection's microtask chain (`.then().catch()`): a macrotask
    // callback only ever runs once every pending microtask has drained, so
    // this is a deterministic way to wait past however many `.then`/`.catch`
    // hops the handler chains — not a race against real-world latency.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(enableCheckbox()).not.toBeChecked()
    expect(mocks.showError).not.toHaveBeenCalled()
    expect(mocks.resume).not.toHaveBeenCalled()
    expect(store.getSnapshot()?.directory).toBeUndefined()
    expect(store.getSnapshot()?.settings.enabled).toBe(false)
  })

  it('changing the folder clears the previous folder’s failure and restarts the loop', async () => {
    await store.setDirectory(USER, fakeDirectory('Backups'))
    await store.recordStatus(USER, {permissionLost: true, lastError: 'the grant lapsed', lastErrorAt: 1})
    mocks.chooseMirrorDirectory.mockResolvedValue(fakeDirectory('Elsewhere'))
    renderDialog()
    await waitForLoaded()
    expect(screen.getByRole('button', {name: /grant access again/i})).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', {name: /change folder/i}))

    await waitFor(() => expect(screen.getByText(/elsewhere/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', {name: /grant access again/i})).toBeNull()
    expect(mocks.resume).toHaveBeenCalled()
  })

  it('an emptied keep-count field is left alone rather than clamped mid-edit', async () => {
    renderDialog()
    await waitForLoaded()
    const write = vi.spyOn(store, 'updateSettings')

    fireEvent.change(screen.getByLabelText(/^keep$/i), {target: {value: ''}})

    // On the WRITE, not on the stored value: a settings write is async, so
    // reading the snapshot straight after the change passes either way.
    expect(write).not.toHaveBeenCalled()
    // And typing on still works — the guard skips the empty field, it does not
    // wedge the input.
    fireEvent.change(screen.getByLabelText(/^keep$/i), {target: {value: '5'}})
    await waitFor(() => expect(store.getSnapshot()?.settings.keepCount).toBe(5))
  })

  it('changing the keep count and the interval persists through the store', async () => {
    renderDialog()
    await waitForLoaded()

    fireEvent.change(screen.getByLabelText(/^keep$/i), { target: { value: '7' } })
    await waitFor(() => expect(store.getSnapshot()?.settings.keepCount).toBe(7))

    fireEvent.change(screen.getByLabelText(/how often/i), { target: { value: '360' } })
    await waitFor(() => expect(store.getSnapshot()?.settings.intervalMinutes).toBe(360))
  })

  it('re-arms the loop on the new interval instead of leaving it on the old delay', async () => {
    renderDialog()
    await waitForLoaded()

    fireEvent.change(screen.getByLabelText(/how often/i), { target: { value: '30' } })

    await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith(30 * 60_000))
  })

  it('a lost permission shows the message and a re-grant button; granting clears the flag and resumes', async () => {
    const directory = fakeDirectory('Backups')
    await store.setDirectory(USER, directory)
    await store.recordStatus(USER, {
      permissionLost: true,
      lastError: 'This browser no longer has permission to write to the chosen folder.',
      lastErrorAt: 1,
    })
    mocks.requestDirectoryPermission.mockResolvedValue('granted')

    renderDialog()
    await waitForLoaded()
    expect(screen.getByText(/no longer has permission/i)).toBeInTheDocument()
    const grantButton = screen.getByRole('button', { name: /grant access again/i })

    await userEvent.click(grantButton)

    await waitFor(() => expect(mocks.requestDirectoryPermission).toHaveBeenCalledWith(directory))
    await waitFor(() => expect(screen.queryByRole('button', { name: /grant access again/i })).toBeNull())
    expect(screen.queryByText(/no longer has permission/i)).toBeNull()
    expect(mocks.resume).toHaveBeenCalled()
    expect(store.getSnapshot()?.status.permissionLost).toBe(false)
  })

  it('a re-grant the browser refuses leaves the flag set', async () => {
    const directory = fakeDirectory('Backups')
    await store.setDirectory(USER, directory)
    await store.recordStatus(USER, {
      permissionLost: true,
      lastError: 'This browser no longer has permission to write to the chosen folder.',
      lastErrorAt: 1,
    })
    mocks.requestDirectoryPermission.mockResolvedValue('denied')

    renderDialog()
    await waitForLoaded()
    const grantButton = screen.getByRole('button', { name: /grant access again/i })

    await userEvent.click(grantButton)

    await waitFor(() => expect(mocks.showError).toHaveBeenCalledWith(expect.stringMatching(/refused/i)))
    expect(screen.getByRole('button', { name: /grant access again/i })).toBeInTheDocument()
    expect(mocks.resume).not.toHaveBeenCalled()
    expect(store.getSnapshot()?.status.permissionLost).toBe(true)
  })

  it('"Mirror now" says another tab is copying rather than reporting nothing at all', async () => {
    mocks.runNow.mockResolvedValue({ outcome: { kind: 'busy-elsewhere' }, intervalMs: 60_000 })
    renderDialog()
    await waitForLoaded()

    await userEvent.click(mirrorNowButton())

    await waitFor(() =>
      expect(mocks.showInfo).toHaveBeenCalledWith(expect.stringMatching(/another tab/i)),
    )
  })

  it('"Mirror now" reports a skipped-unchanged outcome as nothing changed, not as a success or a failure', async () => {
    mocks.runNow.mockResolvedValue({
      outcome: { kind: 'skipped-unchanged', marker: '42' },
      intervalMs: 60_000,
    })
    renderDialog()
    await waitForLoaded()

    await userEvent.click(mirrorNowButton())

    await waitFor(() => expect(mocks.showInfo).toHaveBeenCalledWith(expect.stringMatching(/nothing has changed/i)))
    expect(mocks.showSuccess).not.toHaveBeenCalled()
    expect(mocks.showError).not.toHaveBeenCalled()
  })
})

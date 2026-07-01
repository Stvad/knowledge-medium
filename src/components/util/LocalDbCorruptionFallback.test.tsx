// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  downloadLocalDbBackup: vi.fn(),
  resetLocalDatabase: vi.fn(),
  signOut: vi.fn(),
  localOnly: { value: false },
}))

vi.mock('@/utils/localDbRecovery.js', () => ({
  downloadLocalDbBackup: mocks.downloadLocalDbBackup,
  resetLocalDatabase: mocks.resetLocalDatabase,
}))
vi.mock('@/components/Login.js', () => ({
  useSignOut: () => mocks.signOut,
  useIsLocalOnly: () => mocks.localOnly.value,
}))

import { LocalDbCorruptionFallback } from './LocalDbCorruptionFallback'

const isDisabled = (name: RegExp) =>
  (screen.getByRole('button', { name }) as HTMLButtonElement).disabled

beforeEach(() => {
  vi.clearAllMocks()
  mocks.localOnly.value = false
  mocks.downloadLocalDbBackup.mockResolvedValue({
    filename: 'kmp-v6-u-export-1.db',
    size: 2 * 1024 * 1024,
  })
  mocks.resetLocalDatabase.mockResolvedValue(undefined)
  // jsdom makes location.reload non-configurable; replace the whole location.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { reload: vi.fn(), href: 'http://localhost/' },
  })
})
afterEach(() => cleanup())

describe('LocalDbCorruptionFallback', () => {
  it('reports a started download without claiming the file was saved', async () => {
    render(<LocalDbCorruptionFallback userId="u1" detail="database disk image is malformed" />)
    fireEvent.click(screen.getByRole('button', { name: /download backup/i }))
    await waitFor(() => expect(mocks.downloadLocalDbBackup).toHaveBeenCalledWith('u1'))
    // No false "Saved" claim — the browser gives no completion signal.
    expect(
      await screen.findByText(/Download started for kmp-v6-u-export-1\.db \(2\.0 MiB\)/),
    ).toBeTruthy()
    expect(screen.queryByText(/^Saved /)).toBeNull()
  })

  it('reset requires confirm + a backup + an explicit save confirmation (never automatic)', async () => {
    render(<LocalDbCorruptionFallback userId="u1" detail="malformed" />)
    expect(screen.queryByRole('button', { name: /delete local data & reload/i })).toBeNull()
    expect(mocks.resetLocalDatabase).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /reset & re-sync/i }))
    // Destructive button exists but is disabled until a confirmed backup.
    expect(isDisabled(/delete local data & reload/i)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /delete local data & reload/i }))
    expect(mocks.resetLocalDatabase).not.toHaveBeenCalled()

    // Starting a download is NOT enough — there is no completion signal, so reset
    // stays locked until the user explicitly confirms the file saved.
    fireEvent.click(screen.getByRole('button', { name: /download backup first/i }))
    const confirmBtn = await screen.findByRole('button', { name: /i've saved the backup file/i })
    expect(isDisabled(/delete local data & reload/i)).toBe(true)

    fireEvent.click(confirmBtn)
    await waitFor(() => expect(isDisabled(/delete local data & reload/i)).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: /delete local data & reload/i }))
    await waitFor(() => expect(mocks.resetLocalDatabase).toHaveBeenCalledWith('u1'))
  })

  it('a failed backup unlocks reset so an unreadable file does not trap the user', async () => {
    mocks.downloadLocalDbBackup.mockRejectedValueOnce(new Error('quota exceeded'))
    render(<LocalDbCorruptionFallback userId="u1" detail="malformed" />)
    fireEvent.click(screen.getByRole('button', { name: /reset & re-sync/i }))
    expect(isDisabled(/delete local data & reload/i)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /download backup first/i }))
    await waitFor(() => expect(isDisabled(/delete local data & reload/i)).toBe(false))
    expect(screen.getByText(/backup couldn't be saved/i)).toBeTruthy()
    // No phantom "I've saved the backup file" button when the export threw.
    expect(screen.queryByRole('button', { name: /i've saved the backup file/i })).toBeNull()
  })

  it('cancel backs out of the confirm step without resetting', async () => {
    render(<LocalDbCorruptionFallback userId="u1" detail="malformed" />)
    fireEvent.click(screen.getByRole('button', { name: /reset & re-sync/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('button', { name: /delete local data & reload/i })).toBeNull()
    expect(mocks.resetLocalDatabase).not.toHaveBeenCalled()
  })

  it('surfaces an export failure without resetting', async () => {
    mocks.downloadLocalDbBackup.mockRejectedValueOnce(new Error('quota exceeded'))
    render(<LocalDbCorruptionFallback userId="u1" detail="malformed" />)
    fireEvent.click(screen.getByRole('button', { name: /download backup/i }))
    expect(await screen.findByText(/Couldn't export the database: quota exceeded/)).toBeTruthy()
    expect(mocks.resetLocalDatabase).not.toHaveBeenCalled()
  })

  it('synced workspaces are told the data re-downloads from the server', () => {
    render(<LocalDbCorruptionFallback userId="u1" detail="malformed" />)
    expect(screen.getByText(/re-downloads here/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /reset & re-sync/i })).toBeTruthy()
  })

  it('local-only workspaces are warned there is no server copy (no false re-sync promise)', () => {
    mocks.localOnly.value = true
    render(<LocalDbCorruptionFallback userId="u1" detail="malformed" />)
    // The misleading "re-downloads here" reassurance must NOT appear, and the
    // entry button must not promise a re-sync that can't happen.
    expect(screen.queryByText(/re-downloads here/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /re-sync/i })).toBeNull()
    expect(screen.getAllByText(/local-only/i).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /reset \(delete local data\)/i }))
    expect(screen.getByText(/no server copy/i)).toBeTruthy()
  })
})

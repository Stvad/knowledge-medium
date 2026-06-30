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
  it('downloads a backup of the local DB and confirms the saved file', async () => {
    render(<LocalDbCorruptionFallback userId="u1" detail="database disk image is malformed" />)
    fireEvent.click(screen.getByRole('button', { name: /download backup/i }))
    await waitFor(() => expect(mocks.downloadLocalDbBackup).toHaveBeenCalledWith('u1'))
    expect(await screen.findByText(/Saved kmp-v6-u-export-1\.db \(2\.0 MiB\)/)).toBeTruthy()
  })

  it('reset requires a confirm step AND a backup, then deletes the local DB (never automatic)', async () => {
    render(<LocalDbCorruptionFallback userId="u1" detail="malformed" />)
    // No destructive control is directly clickable on first render.
    expect(screen.queryByRole('button', { name: /delete local data & reload/i })).toBeNull()
    expect(mocks.resetLocalDatabase).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /reset & re-sync/i }))
    // The destructive button exists but is DISABLED until a backup is taken.
    expect(isDisabled(/delete local data & reload/i)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /delete local data & reload/i }))
    expect(mocks.resetLocalDatabase).not.toHaveBeenCalled()

    // Download a backup → the destructive button unlocks.
    fireEvent.click(screen.getByRole('button', { name: /download backup first/i }))
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
  })

  it('local-only workspaces are warned there is no server copy (no false "on the server" claim)', () => {
    mocks.localOnly.value = true
    render(<LocalDbCorruptionFallback userId="u1" detail="malformed" />)
    // The misleading "re-downloads here" reassurance must NOT appear.
    expect(screen.queryByText(/re-downloads here/i)).toBeNull()
    expect(screen.getAllByText(/local-only/i).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /reset & re-sync/i }))
    expect(screen.getByText(/no server copy/i)).toBeTruthy()
  })
})

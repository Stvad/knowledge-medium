// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  downloadLocalDbBackup: vi.fn(),
  resetLocalDatabase: vi.fn(),
  signOut: vi.fn(),
}))

vi.mock('@/utils/localDbRecovery.js', () => ({
  downloadLocalDbBackup: mocks.downloadLocalDbBackup,
  resetLocalDatabase: mocks.resetLocalDatabase,
}))
vi.mock('@/components/Login.js', () => ({ useSignOut: () => mocks.signOut }))

import { LocalDbCorruptionFallback } from './LocalDbCorruptionFallback'

beforeEach(() => {
  vi.clearAllMocks()
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

  it('reset requires a confirm step, then deletes the local DB (never automatic)', async () => {
    render(<LocalDbCorruptionFallback userId="u1" detail="malformed" />)
    // No destructive control is directly clickable on first render.
    expect(screen.queryByRole('button', { name: /delete local data & reload/i })).toBeNull()
    expect(mocks.resetLocalDatabase).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /reset & re-sync/i }))
    fireEvent.click(screen.getByRole('button', { name: /delete local data & reload/i }))

    await waitFor(() => expect(mocks.resetLocalDatabase).toHaveBeenCalledWith('u1'))
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
})

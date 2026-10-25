// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast, Toaster } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { actionsFacet } from '@/extensions/core.js'
import { appUpdate } from '@/appUpdate.js'

const mocks = vi.hoisted(() => ({
  checkForAppUpdate: vi.fn(),
}))

vi.mock('@/registerServiceWorker.js', () => ({
  checkForAppUpdate: mocks.checkForAppUpdate,
}))

import { checkForAppUpdate } from '@/registerServiceWorker.js'
import { appCheckForUpdatesActionContribution } from '../status.ts'

const checkAction = () => resolveFacetRuntimeSync([appCheckForUpdatesActionContribution])
  .read(actionsFacet)
  .find(action => action.id === 'app.checkForUpdates')!

describe('check for updates action', () => {
  beforeEach(() => {
    mocks.checkForAppUpdate.mockReset()
    render(<Toaster />)
  })
  afterEach(() => {
    cleanup()
    toast.dismiss()
    vi.restoreAllMocks()
  })

  it('offers Reload for a found update and reloads only when clicked', async () => {
    vi.mocked(checkForAppUpdate).mockResolvedValue('update-found')
    const reload = vi.spyOn(appUpdate, 'reload').mockImplementation(() => {})

    await checkAction().handler({} as never, {} as never)

    expect(reload).not.toHaveBeenCalled()
    const button = await screen.findByRole('button', {name: 'Reload'})
    fireEvent.click(button)
    expect(reload).toHaveBeenCalledTimes(1)
    reload.mockRestore()
  })

  it.each([
    ['up-to-date', "You're on the latest version."],
    ['no-worker', "Update checks aren't active in this session."],
    ['error', "Couldn't check for updates — check your connection."],
  ] as const)(
    'does not offer an action for %s',
    async (result, message) => {
      vi.mocked(checkForAppUpdate).mockResolvedValue(result)
      await checkAction().handler({} as never, {} as never)
      expect(await screen.findByText(message)).toBeTruthy()
      await waitFor(() => expect(screen.queryByRole('button', {name: 'Reload'})).toBeNull())
    },
  )
})

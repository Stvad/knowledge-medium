// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SyncProgress } from './SyncProgress'
import { UnlockProgress } from './UnlockProgress'

const status = vi.hoisted(() => ({
  current: {connected: false, connecting: false, downloading: false, downloadError: undefined as Error | undefined},
}))

vi.mock('@powersync/react', () => ({
  useStatus: () => status.current,
  useQuery: () => ({data: []}),
}))

afterEach(() => {
  cleanup()
  status.current = {connected: false, connecting: false, downloading: false, downloadError: undefined}
})

describe('SyncProgress', () => {
  it('says the device is offline when asked to show the connection', () => {
    render(<SyncProgress showConnection/>)
    expect(screen.getByRole('status')).toHaveTextContent(/offline/i)
  })

  it('says the download is failing when asked to show the connection', () => {
    status.current = {...status.current, connected: true, downloadError: new Error('token expired')}
    render(<SyncProgress showConnection/>)
    expect(screen.getByRole('status')).toHaveTextContent(/download failed, retrying: token expired/i)
  })

  it('leaves the connection out of an unlock, whose drain is local', () => {
    status.current = {...status.current, downloadError: new Error('token expired')}
    render(<UnlockProgress progress={{kind: 'waiting'}}/>)
    expect(screen.getByRole('status')).not.toHaveTextContent(/offline|download failed/i)

    cleanup()
    status.current = {...status.current, downloadError: undefined}
    render(<UnlockProgress progress={{kind: 'waiting'}}/>)
    expect(screen.getByRole('status')).not.toHaveTextContent(/offline/i)
  })
})

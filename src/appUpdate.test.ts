import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppUpdate, RELOAD_POLL_MS } from './appUpdate'

describe('appUpdate', () => {
  let reload: ReturnType<typeof vi.fn<() => void>>
  const make = () => createAppUpdate({reload})

  beforeEach(() => {
    vi.useFakeTimers()
    reload = vi.fn<() => void>()
    return () => vi.useRealTimers()
  })

  it('only prompts when a newer build takes over the tab', () => {
    const update = make()
    update.markReady()
    vi.advanceTimersByTime(RELOAD_POLL_MS * 4)
    expect(update.phase()).toBe('ready')
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads at once when asked and nothing is being written', () => {
    const update = make()
    update.reload()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('waits for a write in flight before reloading', () => {
    let busy = true
    const update = make()
    update.addBusyCheck(() => busy)
    update.reload()
    update.reload()
    vi.advanceTimersByTime(RELOAD_POLL_MS * 4)
    expect(reload).not.toHaveBeenCalled()

    busy = false
    vi.advanceTimersByTime(RELOAD_POLL_MS)
    expect(reload).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(RELOAD_POLL_MS * 4)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('stops consulting a removed busy check', () => {
    const update = make()
    const remove = update.addBusyCheck(() => true)
    remove()
    update.reload()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('tracks a download and falls back when it fails', () => {
    const update = make()
    const seen: string[] = []
    update.subscribe(() => seen.push(update.phase()))
    update.markDownloading()
    update.markDownloading()
    update.markDownloadFailed()
    expect(seen).toEqual(['downloading', 'current'])
  })

  it('stays ready when a download fails after a newer build took over', () => {
    const update = make()
    update.markReady()
    update.markDownloadFailed()
    update.markDownloading()
    expect(update.phase()).toBe('ready')
  })
})

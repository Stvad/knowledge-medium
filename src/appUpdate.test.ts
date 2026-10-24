// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppUpdate, isTextEntryFocused, RELOAD_POLL_MS } from './appUpdate'

describe('appUpdate', () => {
  let editing: boolean
  let reload: ReturnType<typeof vi.fn<() => void>>
  const make = () => createAppUpdate({reload, isEditing: () => editing})

  beforeEach(() => {
    vi.useFakeTimers()
    editing = false
    reload = vi.fn<() => void>()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reloads at once when a newer build takes over an idle tab', () => {
    const update = make()
    update.markReady()
    expect(update.phase()).toBe('ready')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('waits for editing to end before reloading', () => {
    editing = true
    const update = make()
    update.markReady()
    vi.advanceTimersByTime(RELOAD_POLL_MS * 4)
    expect(reload).not.toHaveBeenCalled()

    editing = false
    vi.advanceTimersByTime(RELOAD_POLL_MS)
    expect(reload).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(RELOAD_POLL_MS * 4)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('waits for a busy check to clear before reloading', () => {
    let busy = true
    const update = make()
    update.addBusyCheck(() => busy)
    update.markReady()
    vi.advanceTimersByTime(RELOAD_POLL_MS * 4)
    expect(reload).not.toHaveBeenCalled()

    busy = false
    vi.advanceTimersByTime(RELOAD_POLL_MS)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('stops consulting a removed busy check', () => {
    const update = make()
    const remove = update.addBusyCheck(() => true)
    remove()
    update.markReady()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('reloads on request while editing, but still not over a write in flight', () => {
    editing = true
    let busy = true
    const update = make()
    update.addBusyCheck(() => busy)
    update.reload()
    vi.advanceTimersByTime(RELOAD_POLL_MS * 4)
    expect(reload).not.toHaveBeenCalled()

    busy = false
    vi.advanceTimersByTime(RELOAD_POLL_MS)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('lets a requested reload override a deferred automatic one', () => {
    editing = true
    const update = make()
    update.markReady()
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
    editing = true
    const update = make()
    update.markReady()
    update.markDownloadFailed()
    update.markDownloading()
    expect(update.phase()).toBe('ready')
  })
})

describe('isTextEntryFocused', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  const focus = (html: string): void => {
    document.body.innerHTML = html
    document.body.querySelector<HTMLElement>('#target')!.focus()
  }

  it('is false with nothing focused', () => {
    expect(isTextEntryFocused(document)).toBe(false)
  })

  it('is true for a focused input, textarea or editable element', () => {
    focus('<input id="target">')
    expect(isTextEntryFocused(document)).toBe(true)
    focus('<textarea id="target"></textarea>')
    expect(isTextEntryFocused(document)).toBe(true)
    focus('<div id="target" contenteditable="true" tabindex="0"></div>')
    expect(isTextEntryFocused(document)).toBe(true)
  })

  it('is false for a focused button', () => {
    focus('<button id="target">Reload</button>')
    expect(isTextEntryFocused(document)).toBe(false)
  })
})

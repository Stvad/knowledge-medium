import {describe, expect, it, vi} from 'vitest'
import {
  buildSafeModeUrl,
  hasSafeModeSearchParam,
  reloadInSafeMode,
  searchHasSafeModeFlag,
} from '@/utils/safeMode.ts'

describe('safe mode URL helpers', () => {
  it('treats useSearchParam null as absent and empty string as present', () => {
    expect(hasSafeModeSearchParam(null)).toBe(false)
    expect(hasSafeModeSearchParam('')).toBe(true)
    expect(hasSafeModeSearchParam('false')).toBe(true)
  })

  it('detects safeMode by query flag presence', () => {
    expect(searchHasSafeModeFlag('?safeMode')).toBe(true)
    expect(searchHasSafeModeFlag('?safeMode=')).toBe(true)
    expect(searchHasSafeModeFlag('?safeMode=false')).toBe(true)
    expect(searchHasSafeModeFlag('?foo=1')).toBe(false)
  })

  it('adds safeMode while preserving existing params and hash route', () => {
    expect(
      buildSafeModeUrl('http://localhost:5173/?foo=1#ws/block'),
    ).toBe('http://localhost:5173/?foo=1&safeMode=#ws/block')
  })

  it('navigates to the same hash route with safeMode enabled', () => {
    const assign = vi.fn()
    const reload = vi.fn()

    reloadInSafeMode({
      href: 'http://localhost:5173/?foo=1#ws/block',
      assign,
      reload,
    } as unknown as Location)

    expect(assign).toHaveBeenCalledWith('http://localhost:5173/?foo=1&safeMode=#ws/block')
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads when the current URL is already the safe-mode URL', () => {
    const assign = vi.fn()
    const reload = vi.fn()

    reloadInSafeMode({
      href: 'http://localhost:5173/?safeMode=#ws/block',
      assign,
      reload,
    } as unknown as Location)

    expect(assign).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalled()
  })
})

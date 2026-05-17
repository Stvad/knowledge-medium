// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import { CallbackSet } from '../callbackSet'

afterEach(() => { vi.restoreAllMocks() })

describe('CallbackSet', () => {
  it('fires every listener with the notify arguments', () => {
    const cs = new CallbackSet<[number, string]>()
    const a = vi.fn()
    const b = vi.fn()
    cs.add(a)
    cs.add(b)

    cs.notify(7, 'hi')

    expect(a).toHaveBeenCalledWith(7, 'hi')
    expect(b).toHaveBeenCalledWith(7, 'hi')
  })

  it('returns an unsubscribe that removes the listener', () => {
    const cs = new CallbackSet<[]>()
    const listener = vi.fn()
    const off = cs.add(listener)

    cs.notify()
    off()
    cs.notify()

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('lets a listener unsubscribe itself without skipping the next one', () => {
    const cs = new CallbackSet<[]>()
    const calls: string[] = []
    let offA: () => void = () => {}
    offA = cs.add(() => {
      calls.push('a')
      offA()
    })
    cs.add(() => { calls.push('b') })

    cs.notify()
    cs.notify()

    expect(calls).toEqual(['a', 'b', 'b'])
  })

  it('keeps notifying remaining listeners when one throws', () => {
    const cs = new CallbackSet<[]>('test-set')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const survivor = vi.fn()
    cs.add(() => { throw new Error('boom') })
    cs.add(survivor)

    cs.notify()

    expect(survivor).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0][0])).toContain('test-set')
  })

  it('size reflects active listeners; clear drops everything', () => {
    const cs = new CallbackSet<[]>()
    cs.add(() => {})
    cs.add(() => {})
    expect(cs.size).toBe(2)
    cs.clear()
    expect(cs.size).toBe(0)
  })
})

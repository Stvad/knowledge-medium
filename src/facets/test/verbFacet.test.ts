import { describe, expect, it, vi } from 'vitest'
import { defineVerbFacet } from '../verbFacet.ts'
import { resolveFacetRuntimeSync } from '../facet.ts'

describe('defineVerbFacet', () => {
  it('runs the default impl when nothing is contributed', async () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.default',
      defaultImpl: n => n + 1,
    })
    const runtime = resolveFacetRuntimeSync([])

    await expect(verb.run(runtime, 1)).resolves.toBe(2)
  })

  it('impl replaces the default (last-wins by precedence; warns once)', async () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.impl',
      defaultImpl: n => n,
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = resolveFacetRuntimeSync([
      verb.impl(n => n * 10, {precedence: 1}),
      verb.impl(n => n * 100, {precedence: 2}),
    ])

    // Highest-precedence impl wins; the default and the lower impl are ignored.
    await expect(verb.run(runtime, 3)).resolves.toBe(300)
    // The multiple-impl warning is emitted in `combine` (once per resolution),
    // not per run — running twice must not re-warn.
    await verb.run(runtime, 3)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('at equal precedence the last-registered impl wins', async () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.impl-tie',
      defaultImpl: n => n,
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = resolveFacetRuntimeSync([
      verb.impl(n => n + 1),
      verb.impl(n => n + 2),
    ])

    await expect(verb.run(runtime, 10)).resolves.toBe(12)
    warn.mockRestore()
  })

  it('decorators wrap the impl; lower precedence is innermost', async () => {
    const verb = defineVerbFacet<string, string>({
      id: 'test.verb.decorators',
      defaultImpl: s => s,
    })
    // Each decorator appends a tag to the result. Folding ascending by
    // precedence means `low` wraps the impl first (innermost) and `high`
    // wraps that (outermost), so `high`'s tag lands last.
    const runtime = resolveFacetRuntimeSync([
      verb.decorator(next => async s => `${await next(s)}|low`, {precedence: 1}),
      verb.decorator(next => async s => `${await next(s)}|high`, {precedence: 2}),
    ])

    await expect(verb.run(runtime, 'x')).resolves.toBe('x|low|high')
  })

  it('at equal precedence decorators fold in registration order', async () => {
    const verb = defineVerbFacet<string, string>({
      id: 'test.verb.decorator-tie',
      defaultImpl: s => s,
    })
    const runtime = resolveFacetRuntimeSync([
      verb.decorator(next => async s => `${await next(s)}|a`),
      verb.decorator(next => async s => `${await next(s)}|b`),
    ])

    // First-registered wraps the impl first (innermost) → its tag is closest.
    await expect(verb.run(runtime, 'x')).resolves.toBe('x|a|b')
  })

  it('a decorator can transform the input before the impl sees it', async () => {
    const verb = defineVerbFacet<string, string>({
      id: 'test.verb.input-transform',
      defaultImpl: s => `impl(${s})`,
    })
    const runtime = resolveFacetRuntimeSync([
      verb.decorator(next => s => next(s.toUpperCase())),
    ])

    await expect(verb.run(runtime, 'hi')).resolves.toBe('impl(HI)')
  })

  it('a decorator can short-circuit without calling next (veto/guard)', async () => {
    const impl = vi.fn((n: number) => n)
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.shortcircuit',
      defaultImpl: impl,
    })
    const runtime = resolveFacetRuntimeSync([
      verb.decorator(() => () => -1),
    ])

    await expect(verb.run(runtime, 5)).resolves.toBe(-1)
    expect(impl).not.toHaveBeenCalled()
  })

  it('before/after observers run, in order, with the input and the result', async () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.observers',
      defaultImpl: n => n * 2,
    })
    const calls: string[] = []
    const runtime = resolveFacetRuntimeSync([
      verb.before(input => {
        calls.push(`before1:${input}`)
      }),
      verb.before(input => {
        calls.push(`before2:${input}`)
      }),
      verb.after((input, result) => {
        calls.push(`after1:${input}:${result}`)
      }),
      verb.after((input, result) => {
        calls.push(`after2:${input}:${result}`)
      }),
    ])

    await expect(verb.run(runtime, 4)).resolves.toBe(8)
    expect(calls).toEqual(['before1:4', 'before2:4', 'after1:4:8', 'after2:4:8'])
  })

  it('isolates observer errors so they cannot break the verb', async () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.observer-error',
      defaultImpl: n => n,
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const after = vi.fn()
    const runtime = resolveFacetRuntimeSync([
      verb.before(() => {
        throw new Error('boom')
      }),
      verb.after(after),
    ])

    await expect(verb.run(runtime, 7)).resolves.toBe(7)
    expect(after).toHaveBeenCalledWith(7, 7)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('falls back to defaultImpl when a plugin impl throws', async () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.impl-throws',
      defaultImpl: n => n + 1000,
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = resolveFacetRuntimeSync([
      verb.impl(() => {
        throw new Error('plugin impl boom')
      }),
    ])

    await expect(verb.run(runtime, 5)).resolves.toBe(1005)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('falls back to defaultImpl when a decorator throws', async () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.decorator-throws',
      defaultImpl: n => n,
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = resolveFacetRuntimeSync([
      verb.decorator(() => () => {
        throw new Error('decorator boom')
      }),
    ])

    await expect(verb.run(runtime, 9)).resolves.toBe(9)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('after-observers still run with the fallback result when the impl throws', async () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.after-on-fallback',
      defaultImpl: n => n * 2,
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const after = vi.fn()
    const runtime = resolveFacetRuntimeSync([
      verb.impl(() => {
        throw new Error('boom')
      }),
      verb.after(after),
    ])

    await expect(verb.run(runtime, 4)).resolves.toBe(8)
    expect(after).toHaveBeenCalledWith(4, 8)
    consoleError.mockRestore()
  })

  it('rejects (no infinite fallback) when the bare default impl throws', async () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.default-throws',
      defaultImpl: () => {
        throw new Error('core bug')
      },
    })
    const runtime = resolveFacetRuntimeSync([])

    await expect(verb.run(runtime, 1)).rejects.toThrow('core bug')
  })
})

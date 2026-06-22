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

  it('impl replaces the default (last-wins by precedence)', async () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.impl',
      defaultImpl: n => n,
    })
    const runtime = resolveFacetRuntimeSync([
      verb.impl(n => n * 10, {precedence: 1}),
      verb.impl(n => n * 100, {precedence: 2}),
    ])

    // Highest-precedence impl wins; the default and the lower impl are ignored.
    await expect(verb.run(runtime, 3)).resolves.toBe(300)
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

  it('before/after observers run with the input and the result', async () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.observers',
      defaultImpl: n => n * 2,
    })
    const calls: string[] = []
    const runtime = resolveFacetRuntimeSync([
      verb.before(input => {
        calls.push(`before:${input}`)
      }),
      verb.after((input, result) => {
        calls.push(`after:${input}:${result}`)
      }),
    ])

    await expect(verb.run(runtime, 4)).resolves.toBe(8)
    expect(calls).toEqual(['before:4', 'after:4:8'])
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
})

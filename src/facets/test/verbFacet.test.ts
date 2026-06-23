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
      verb.after((input, outcome) => {
        calls.push(`after1:${input}:${outcome.ok ? outcome.result : 'err'}`)
      }),
      verb.after((input, outcome) => {
        calls.push(`after2:${input}:${outcome.ok ? outcome.result : 'err'}`)
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
    expect(after).toHaveBeenCalledWith(7, {ok: true, result: 7})
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('falls back to defaultImpl when a plugin impl throws', async () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.impl-throws',
      defaultImpl: n => n + 1000,
      onError: 'fallback',
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

  it('falls back to defaultImpl when a decorator wrapper throws (at call time)', async () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.decorator-call-throws',
      defaultImpl: n => n,
      onError: 'fallback',
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

  it('falls back to defaultImpl when a decorator throws while wrapping (at apply time)', async () => {
    // The decorator factory itself throws when applied (building the chain),
    // before any wrapper is called — this must still degrade to the default
    // rather than rejecting and breaking the verb for every caller.
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.decorator-wrap-throws',
      defaultImpl: n => n + 1,
      onError: 'fallback',
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = resolveFacetRuntimeSync([
      verb.decorator(() => {
        throw new Error('wrap boom')
      }),
    ])

    await expect(verb.run(runtime, 5)).resolves.toBe(6)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('after-observers still run with the fallback result when the impl throws', async () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.after-on-fallback',
      defaultImpl: n => n * 2,
      onError: 'fallback',
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
    expect(after).toHaveBeenCalledWith(4, {ok: true, result: 8})
    consoleError.mockRestore()
  })

  it('rejects when the fallback default itself returns an invalid result', async () => {
    // validateResult guards THE result, including the fallback default — a core
    // default that returns garbage is a bug to surface, not to pass through.
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.fallback-default-invalid',
      defaultImpl: () => undefined as unknown as number,
      onError: 'fallback',
      validateResult: n => typeof n === 'number' && Number.isFinite(n),
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = resolveFacetRuntimeSync([
      // A plugin impl throws → fall back to the (also-invalid) default → reject.
      verb.impl(() => {
        throw new Error('plugin boom')
      }),
    ])

    await expect(verb.run(runtime, 1)).rejects.toThrow(/invalid result/)
    consoleError.mockRestore()
  })

  it('runs after-observers with the error outcome when run rejects under rethrow', async () => {
    // `after` observes EVERY outcome: a crashed (rethrow) run still fires `after`
    // with {ok: false, error} just before rejecting — so before/after stay
    // symmetric and failures are observable without a decorator try/finally.
    const boom = new Error('boom')
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.after-on-rethrow',
      defaultImpl: n => n,
    })
    const after = vi.fn()
    const runtime = resolveFacetRuntimeSync([
      verb.impl(() => {
        throw boom
      }),
      verb.after(after),
    ])

    await expect(verb.run(runtime, 1)).rejects.toThrow('boom')
    expect(after).toHaveBeenCalledWith(1, {ok: false, error: boom})
  })

  it('rejects with the fallback error and fires after({ok:false}) once when the fallback default throws', async () => {
    // fallback + plugin impl throws + the defaultImpl ALSO throws: reject with
    // the fallback error, and `after` still observes the failure exactly once.
    const fallbackBoom = new Error('default boom')
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.fallback-default-throws',
      defaultImpl: () => {
        throw fallbackBoom
      },
      onError: 'fallback',
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const after = vi.fn()
    const runtime = resolveFacetRuntimeSync([
      verb.impl(() => {
        throw new Error('plugin boom')
      }),
      verb.after(after),
    ])

    await expect(verb.run(runtime, 3)).rejects.toThrow('default boom')
    expect(after).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledWith(3, {ok: false, error: fallbackBoom})
    consoleError.mockRestore()
  })

  it('an after-observer that throws on a failure outcome does not mask the real rejection', async () => {
    // The riskiest isolation path: an after-observer throwing while observing a
    // FAILURE. Its error is swallowed; `run` still rejects with the ORIGINAL error.
    const realError = new Error('real boom')
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.after-throws-on-failure',
      defaultImpl: n => n,
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = resolveFacetRuntimeSync([
      verb.impl(() => {
        throw realError
      }),
      verb.after(() => {
        throw new Error('observer boom')
      }),
    ])

    await expect(verb.run(runtime, 1)).rejects.toThrow('real boom')
    expect(consoleError).toHaveBeenCalled()
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

  it('falls back to defaultImpl when an impl returns a result failing validateResult', async () => {
    // An untyped plugin can return a malformed result without throwing; with
    // validateResult that degrades to the default instead of reaching callers.
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.invalid-result',
      defaultImpl: () => 0,
      onError: 'fallback',
      validateResult: n => typeof n === 'number' && Number.isFinite(n),
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = resolveFacetRuntimeSync([
      verb.impl(() => undefined as unknown as number),
    ])

    await expect(verb.run(runtime, 5)).resolves.toBe(0)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('rethrows and does NOT re-run the default when an impl throws (default onError)', async () => {
    const defaultImpl = vi.fn((n: number) => n + 1000)
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.rethrow-impl',
      defaultImpl,
    })
    const runtime = resolveFacetRuntimeSync([
      verb.impl(() => {
        throw new Error('plugin impl boom')
      }),
    ])

    // Default policy is 'rethrow': the error surfaces and the default is never
    // re-run — the safe policy for an effectful verb (no double-execution).
    await expect(verb.run(runtime, 5)).rejects.toThrow('plugin impl boom')
    expect(defaultImpl).not.toHaveBeenCalled()
  })

  it('rethrows when a decorator throws (default onError)', async () => {
    const defaultImpl = vi.fn((n: number) => n)
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.rethrow-decorator',
      defaultImpl,
    })
    const runtime = resolveFacetRuntimeSync([
      verb.decorator(() => () => {
        throw new Error('decorator boom')
      }),
    ])

    await expect(verb.run(runtime, 9)).rejects.toThrow('decorator boom')
    expect(defaultImpl).not.toHaveBeenCalled()
  })

  it('rethrows when a result fails validateResult (default onError)', async () => {
    const defaultImpl = vi.fn(() => 0)
    const verb = defineVerbFacet<number, number>({
      id: 'test.verb.rethrow-invalid',
      defaultImpl,
      validateResult: n => typeof n === 'number' && Number.isFinite(n),
    })
    const runtime = resolveFacetRuntimeSync([
      verb.impl(() => undefined as unknown as number),
    ])

    await expect(verb.run(runtime, 5)).rejects.toThrow(/invalid result/)
    expect(defaultImpl).not.toHaveBeenCalled()
  })
})

describe('defineVerbFacet runSync', () => {
  it('runs the default impl synchronously when nothing is contributed', () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.sync.default',
      defaultImpl: n => n + 1,
    })
    const runtime = resolveFacetRuntimeSync([])

    expect(verb.runSync(runtime, 1)).toBe(2)
  })

  it('folds decorators over the impl, lower precedence innermost (same order as run)', () => {
    const verb = defineVerbFacet<string, string>({
      id: 'test.sync.decorators',
      defaultImpl: s => s,
    })
    const runtime = resolveFacetRuntimeSync([
      verb.decorator(next => s => `${next(s)}|low`, {precedence: 1}),
      verb.decorator(next => s => `${next(s)}|high`, {precedence: 2}),
    ])

    expect(verb.runSync(runtime, 'x')).toBe('x|low|high')
  })

  it('impl replaces the default; a decorator can veto without calling next', () => {
    const impl = vi.fn((n: number) => n)
    const verb = defineVerbFacet<number, number>({
      id: 'test.sync.veto',
      defaultImpl: impl,
    })
    const runtime = resolveFacetRuntimeSync([
      verb.decorator(() => () => -1),
    ])

    expect(verb.runSync(runtime, 5)).toBe(-1)
    expect(impl).not.toHaveBeenCalled()
  })

  it('runs before/after observers in order with the input and result', () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.sync.observers',
      defaultImpl: n => n * 2,
    })
    const calls: string[] = []
    const runtime = resolveFacetRuntimeSync([
      verb.before(input => { calls.push(`before:${input}`) }),
      verb.after((input, outcome) => {
        calls.push(`after:${input}:${outcome.ok ? outcome.result : 'err'}`)
      }),
    ])

    expect(verb.runSync(runtime, 4)).toBe(8)
    expect(calls).toEqual(['before:4', 'after:4:8'])
  })

  it('falls back to the sync default when a contribution returns a promise (fallback)', () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.sync.promise-fallback',
      defaultImpl: n => n + 1000,
      onError: 'fallback',
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = resolveFacetRuntimeSync([
      // An async (promise-returning) impl violates the sync contract.
      verb.impl(async n => n),
    ])

    expect(verb.runSync(runtime, 5)).toBe(1005)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('a promise-returning decorator also violates the contract and falls back', () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.sync.promise-decorator',
      defaultImpl: n => n + 1,
      onError: 'fallback',
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = resolveFacetRuntimeSync([
      verb.decorator(() => async n => n),
    ])

    expect(verb.runSync(runtime, 5)).toBe(6)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('throws (no default re-run) when a contribution returns a promise under rethrow', () => {
    const defaultImpl = vi.fn((n: number) => n)
    const verb = defineVerbFacet<number, number>({
      id: 'test.sync.promise-rethrow',
      defaultImpl,
    })
    const runtime = resolveFacetRuntimeSync([
      verb.impl(async n => n),
    ])

    expect(() => verb.runSync(runtime, 5)).toThrow(/synchronous contributions/)
    expect(defaultImpl).not.toHaveBeenCalled()
  })

  it('falls back to the default when a sync impl throws (fallback)', () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.sync.impl-throws',
      defaultImpl: n => n + 1000,
      onError: 'fallback',
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = resolveFacetRuntimeSync([
      verb.impl(() => { throw new Error('boom') }),
    ])

    expect(verb.runSync(runtime, 5)).toBe(1005)
    consoleError.mockRestore()
  })

  it('rethrows when a sync impl throws and does not re-run the default (default onError)', () => {
    const defaultImpl = vi.fn((n: number) => n + 1000)
    const verb = defineVerbFacet<number, number>({
      id: 'test.sync.impl-rethrows',
      defaultImpl,
    })
    const runtime = resolveFacetRuntimeSync([
      verb.impl(() => { throw new Error('plugin boom') }),
    ])

    expect(() => verb.runSync(runtime, 5)).toThrow('plugin boom')
    expect(defaultImpl).not.toHaveBeenCalled()
  })

  it('falls back when a result fails validateResult', () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.sync.invalid-result',
      defaultImpl: () => 0,
      onError: 'fallback',
      validateResult: n => typeof n === 'number' && Number.isFinite(n),
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = resolveFacetRuntimeSync([
      verb.impl(() => undefined as unknown as number),
    ])

    expect(verb.runSync(runtime, 5)).toBe(0)
    consoleError.mockRestore()
  })

  it('isolates a throwing observer; an async observer is fire-and-forget, never gating the result', async () => {
    const verb = defineVerbFacet<number, number>({
      id: 'test.sync.observer-isolation',
      defaultImpl: n => n,
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const after = vi.fn()
    const runtime = resolveFacetRuntimeSync([
      verb.before(() => { throw new Error('sync observer boom') }),
      // An async before-observer is allowed but must NOT gate the sync result;
      // its eventual rejection is swallowed (not an unhandled rejection).
      verb.before(async () => { throw new Error('async observer reject') }),
      verb.after(after),
    ])

    expect(verb.runSync(runtime, 7)).toBe(7)
    expect(after).toHaveBeenCalledWith(7, {ok: true, result: 7})
    expect(consoleError).toHaveBeenCalled()
    // Let the async observer's rejection settle so its handler runs.
    await Promise.resolve()
    consoleError.mockRestore()
  })

  it('runs after-observers with the error outcome before throwing under rethrow', () => {
    const boom = new Error('boom')
    const verb = defineVerbFacet<number, number>({
      id: 'test.sync.after-on-rethrow',
      defaultImpl: n => n,
    })
    const after = vi.fn()
    const runtime = resolveFacetRuntimeSync([
      verb.impl(() => { throw boom }),
      verb.after(after),
    ])

    expect(() => verb.runSync(runtime, 1)).toThrow('boom')
    expect(after).toHaveBeenCalledWith(1, {ok: false, error: boom})
  })
})

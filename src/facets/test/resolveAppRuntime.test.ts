/**
 * Unit tests for the boundary-aware runtime resolver.
 *
 * Walks live in resolveAppRuntime.ts. These tests verify only the
 * extra semantics over the bare facet collectors: BOUNDARY skip,
 * essential override, sync-vs-async function policy, dedup, and
 * `enables` recursion gated on parent acceptance.
 */
import {describe, expect, it, vi} from 'vitest'
import {defineFacet} from '@/facets/facet.js'
import {systemToggle, type Overrides} from '@/facets/togglable.js'
import {
  resolveAppRuntime,
  resolveAppRuntimeSync,
} from '@/facets/resolveAppRuntime.js'

const empty: Overrides = new Map()

describe('resolveAppRuntime — boundary filter', () => {
  it('excludes contributions inside a disabled boundary', () => {
    const labels = defineFacet<string, string>({
      id: 'test.labels',
      combine: vs => vs.join(','),
      empty: () => '',
    })
    const handle = systemToggle({id: 'system:x', name: 'X'})

    const runtime = resolveAppRuntimeSync(
      [labels.of('outside'), handle.of([labels.of('inside')])],
      {overrides: new Map([['system:x', false]])},
    )

    expect(runtime.read(labels)).toBe('outside')
  })

  it('includes contributions inside an enabled boundary', () => {
    const labels = defineFacet<string, string>({
      id: 'test.labels-on',
      combine: vs => vs.join(','),
      empty: () => '',
    })
    const handle = systemToggle({id: 'system:on', name: 'On'})

    const runtime = resolveAppRuntimeSync(
      [labels.of('outside'), handle.of([labels.of('inside')])],
      {overrides: empty},
    )

    expect(runtime.read(labels)).toBe('outside,inside')
  })

  it('honours defaultEnabled: false in the absence of an override', () => {
    const labels = defineFacet<string, string>({
      id: 'test.opt-in',
      combine: vs => vs.join(','),
      empty: () => '',
    })
    const handle = systemToggle({
      id: 'system:opt-in',
      name: 'Opt-in',
      defaultEnabled: false,
    })

    const runtime = resolveAppRuntimeSync(
      [handle.of([labels.of('hidden')])],
      {overrides: empty},
    )

    expect(runtime.read(labels)).toBe('')
  })

  it('forces essential boundaries on regardless of override', () => {
    const labels = defineFacet<string, string>({
      id: 'test.essential',
      combine: vs => vs.join(','),
      empty: () => '',
    })
    const handle = systemToggle({
      id: 'system:core',
      name: 'Core',
      essential: true,
    })

    const runtime = resolveAppRuntimeSync(
      [handle.of([labels.of('always-on')])],
      {overrides: new Map([['system:core', false]])},
    )

    expect(runtime.read(labels)).toBe('always-on')
  })

  it('handles nested boundaries — inner-off short-circuits while siblings stay on', () => {
    const labels = defineFacet<string, string>({
      id: 'test.nested',
      combine: vs => vs.join(','),
      empty: () => '',
    })
    const outer = systemToggle({id: 'system:outer', name: 'Outer'})
    const inner = systemToggle({id: 'system:inner', name: 'Inner'})

    const runtime = resolveAppRuntimeSync(
      [
        outer.of([
          labels.of('outer-direct'),
          inner.of([labels.of('inner')]),
          labels.of('outer-sibling'),
        ]),
      ],
      {overrides: new Map([['system:inner', false]])},
    )

    expect(runtime.read(labels)).toBe('outer-direct,outer-sibling')
  })
})

describe('resolveAppRuntime — function-valued nodes', () => {
  it('awaits function nodes in the async variant', async () => {
    const labels = defineFacet<string, string>({
      id: 'test.fn-async',
      combine: vs => vs.join(','),
      empty: () => '',
    })

    const runtime = await resolveAppRuntime(
      [async () => labels.of('async-value')],
      {overrides: empty},
    )

    expect(runtime.read(labels)).toBe('async-value')
  })

  it('throws on function nodes in the sync variant', () => {
    const labels = defineFacet<string, string>({
      id: 'test.fn-sync',
      combine: vs => vs.join(','),
      empty: () => '',
    })

    expect(() =>
      resolveAppRuntimeSync(
        [() => labels.of('whatever')],
        {overrides: empty},
      ),
    ).toThrow(/cannot resolve function-valued AppExtension/i)
  })

  it('applies boundary filter to function-returned subtrees', async () => {
    const labels = defineFacet<string, string>({
      id: 'test.fn-bound',
      combine: vs => vs.join(','),
      empty: () => '',
    })
    const handle = systemToggle({id: 'system:fb', name: 'FB'})

    const runtime = await resolveAppRuntime(
      [async () => handle.of([labels.of('from-fn')])],
      {overrides: new Map([['system:fb', false]])},
    )

    expect(runtime.read(labels)).toBe('')
  })
})

describe('resolveAppRuntime — dedup + validation parity', () => {
  it('dedups by FacetContribution reference', async () => {
    const labels = defineFacet<string, string>({
      id: 'test.dedup',
      combine: vs => vs.join(','),
      empty: () => '',
    })
    const shared = labels.of('shared')

    const runtime = await resolveAppRuntime(
      [shared, [shared, shared]],
      {overrides: empty},
    )

    expect(runtime.read(labels)).toBe('shared')
  })

  it('drops invalid contributions while logging', () => {
    const numbers = defineFacet<number, number>({
      id: 'test.validated',
      combine: vs => vs.reduce((a, b) => a + b, 0),
      empty: () => 0,
      validate: (v): v is number => typeof v === 'number',
    })

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const runtime = resolveAppRuntimeSync(
        [
          numbers.of(2),
          {
            type: 'facet-contribution',
            facet: {id: numbers.id, validate: numbers.validate},
            value: 'nope' as unknown as number,
          },
          numbers.of(3),
        ],
        {overrides: empty},
      )

      expect(error).toHaveBeenCalledTimes(1)
      expect(runtime.read(numbers)).toBe(5)
    } finally {
      error.mockRestore()
    }
  })
})

describe('resolveAppRuntime — FacetContribution.enables', () => {
  it('recurses into enables when the parent contribution is accepted', () => {
    const labels = defineFacet<string, string>({
      id: 'test.enables',
      combine: vs => vs.join(','),
      empty: () => '',
    })
    const numbers = defineFacet<number, number>({
      id: 'test.enables-parent',
      combine: vs => vs.reduce((a, b) => a + b, 0),
      empty: () => 0,
      validate: (v): v is number => typeof v === 'number',
    })

    const parent = numbers.of(1)
    // enables is a slice-7 field; we attach it inline for this test.
    const parentWithEnables = {
      ...parent,
      enables: [labels.of('child-of-accepted')],
    }

    const runtime = resolveAppRuntimeSync([parentWithEnables], {overrides: empty})

    expect(runtime.read(numbers)).toBe(1)
    expect(runtime.read(labels)).toBe('child-of-accepted')
  })

  it('drops enables when the parent contribution fails validation', () => {
    const labels = defineFacet<string, string>({
      id: 'test.enables-drop',
      combine: vs => vs.join(','),
      empty: () => '',
    })
    const numbers = defineFacet<number, number>({
      id: 'test.enables-drop-parent',
      combine: vs => vs.reduce((a, b) => a + b, 0),
      empty: () => 0,
      validate: (v): v is number => typeof v === 'number',
    })

    const invalidParentWithEnables = {
      type: 'facet-contribution' as const,
      facet: {id: numbers.id, validate: numbers.validate},
      value: 'not a number' as unknown as number,
      enables: [labels.of('child-orphaned')],
    }

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const runtime = resolveAppRuntimeSync([invalidParentWithEnables], {
        overrides: empty,
      })
      expect(runtime.read(labels)).toBe('')
    } finally {
      error.mockRestore()
    }
  })
})

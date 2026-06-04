import { describe, expect, it, vi } from 'vitest'
import { defineFacet, resolveFacetRuntime, resolveFacetRuntimeSync } from '@/extensions/facet.js'

describe('facet runtime', () => {
  it('combines nested and async contributions in precedence order', async () => {
    const labelsFacet = defineFacet<string, string>({
      id: 'test.labels',
      combine: values => values.join(','),
      empty: () => '',
    })

    const runtime = await resolveFacetRuntime([
      labelsFacet.of('middle'),
      [
        labelsFacet.of('last', {precedence: 10}),
        async () => labelsFacet.of('first', {precedence: -10}),
      ],
    ])

    expect(runtime.read(labelsFacet)).toBe('first,middle,last')
  })

  it('returns the facet empty value when nothing contributed', async () => {
    const countFacet = defineFacet<number, number>({
      id: 'test.count',
      combine: values => values.reduce((sum, value) => sum + value, 0),
      empty: () => 0,
    })

    const runtime = await resolveFacetRuntime([])

    expect(runtime.read(countFacet)).toBe(0)
  })

  it('can resolve synchronous extensions without suspending', () => {
    const labelsFacet = defineFacet<string, string>({
      id: 'test.sync-labels',
      combine: values => values.join(','),
      empty: () => '',
    })

    const runtime = resolveFacetRuntimeSync([
      labelsFacet.of('a'),
      [labelsFacet.of('b')],
    ])

    expect(runtime.read(labelsFacet)).toBe('a,b')
  })

  it('drops invalid contributions at registration time', async () => {
    const numbersFacet = defineFacet<number, number>({
      id: 'test.validated-numbers',
      combine: values => values.reduce((sum, value) => sum + value, 0),
      empty: () => 0,
      validate: (value): value is number => typeof value === 'number',
    })

    const invalidContribution = {
      type: 'facet-contribution' as const,
      facet: {id: numbersFacet.id, validate: numbersFacet.validate},
      value: 'not a number' as unknown as number,
    }

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const runtime = await resolveFacetRuntime([
        numbersFacet.of(2),
        invalidContribution,
        numbersFacet.of(3),
      ])

      expect(error).toHaveBeenCalledTimes(1)
      expect(error.mock.calls[0]?.[0]).toContain('test.validated-numbers')
      expect(runtime.read(numbersFacet)).toBe(5)
    } finally {
      error.mockRestore()
    }
  })
})

// The runtime-mutation path (setRuntimeContributions + onFacetChange) backs
// every live service effect — keybinding overrides, theme registry, user
// schemas/types. It had no direct coverage; a regression silently breaks
// reactive facet updates across the app.
describe('FacetRuntime runtime contributions', () => {
  const labelsFacet = defineFacet<string, string>({
    id: 'test.runtime-labels',
    combine: values => values.join(','),
    empty: () => '',
  })

  it('merges a runtime bucket with static contributions and reflects it in read', () => {
    const runtime = resolveFacetRuntimeSync([labelsFacet.of('static')])
    expect(runtime.read(labelsFacet)).toBe('static')

    runtime.setRuntimeContributions(labelsFacet, 'svc', ['live-a', 'live-b'])
    expect(runtime.read(labelsFacet)).toBe('static,live-a,live-b')
  })

  it('replaces (does not append to) a bucket on a second call for the same source', () => {
    const runtime = resolveFacetRuntimeSync([])
    runtime.setRuntimeContributions(labelsFacet, 'svc', ['first'])
    runtime.setRuntimeContributions(labelsFacet, 'svc', ['second'])
    expect(runtime.read(labelsFacet)).toBe('second')
  })

  it('removes the bucket when given an empty array (falls back to static/empty)', () => {
    const runtime = resolveFacetRuntimeSync([labelsFacet.of('static')])
    runtime.setRuntimeContributions(labelsFacet, 'svc', ['live'])
    expect(runtime.read(labelsFacet)).toBe('static,live')

    runtime.setRuntimeContributions(labelsFacet, 'svc', [])
    expect(runtime.read(labelsFacet)).toBe('static')
  })

  it('fires onFacetChange once per setRuntimeContributions on that facet', () => {
    const runtime = resolveFacetRuntimeSync([])
    const fired = vi.fn()
    runtime.onFacetChange(labelsFacet.id, fired)

    runtime.setRuntimeContributions(labelsFacet, 'svc', ['a'])
    runtime.setRuntimeContributions(labelsFacet, 'svc', ['b'])
    expect(fired).toHaveBeenCalledTimes(2)
  })

  it('does not fire listeners registered for a different facet', () => {
    const otherFacet = defineFacet<string, string>({
      id: 'test.runtime-other',
      combine: values => values.join(','),
      empty: () => '',
    })
    const runtime = resolveFacetRuntimeSync([])
    const onLabels = vi.fn()
    const onOther = vi.fn()
    runtime.onFacetChange(labelsFacet.id, onLabels)
    runtime.onFacetChange(otherFacet.id, onOther)

    runtime.setRuntimeContributions(labelsFacet, 'svc', ['a'])
    expect(onLabels).toHaveBeenCalledTimes(1)
    expect(onOther).not.toHaveBeenCalled()
  })

  it('stops notifying after unsubscribe', () => {
    const runtime = resolveFacetRuntimeSync([])
    const fired = vi.fn()
    const unsubscribe = runtime.onFacetChange(labelsFacet.id, fired)

    runtime.setRuntimeContributions(labelsFacet, 'svc', ['a'])
    unsubscribe()
    runtime.setRuntimeContributions(labelsFacet, 'svc', ['b'])
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('isolates a throwing listener so others still run', () => {
    const runtime = resolveFacetRuntimeSync([])
    const boom = vi.fn(() => { throw new Error('listener boom') })
    const ok = vi.fn()
    runtime.onFacetChange(labelsFacet.id, boom)
    runtime.onFacetChange(labelsFacet.id, ok)

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      runtime.setRuntimeContributions(labelsFacet, 'svc', ['a'])
      expect(boom).toHaveBeenCalledTimes(1)
      expect(ok).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })
})

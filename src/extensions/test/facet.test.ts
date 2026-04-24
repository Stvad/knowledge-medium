import { describe, expect, it, vi } from 'vitest'
import { defineFacet, resolveFacetRuntime, resolveFacetRuntimeSync } from '@/extensions/facet.ts'

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

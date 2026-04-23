import { describe, expect, it } from 'vitest'
import { defineFacet, resolveFacetRuntime } from '@/extensions/facet.ts'

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
})

import { describe, expect, it, vi } from 'vitest'
import { dedupById, defineFacet, resolveFacetRuntime, resolveFacetRuntimeSync } from '@/facets/facet.js'

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

// `dedupById` is the combine for id-bearing list facets (app/panel/header
// mounts). It collapses logical duplicates the resolver's reference dedup
// can't catch — fresh contributions, same `id` — to a single last-wins
// survivor (#64). Covered directly here so the mount facets in core.ts
// don't each re-test the same machinery.
describe('dedupById combine', () => {
  interface Mount { id: string; label: string }
  const mounts = defineFacet<Mount, readonly Mount[]>({
    id: 'test.id-dedup',
    combine: dedupById('test.id-dedup'),
    empty: () => [],
  })

  it('collapses distinct contributions sharing an id to one (last-wins), preserving first-seen order', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const runtime = resolveFacetRuntimeSync([
        mounts.of({id: 'a', label: 'first'}),
        mounts.of({id: 'b', label: 'only-b'}),
        mounts.of({id: 'a', label: 'second'}),
      ])

      // Single `a`, value from the later contribution, still positioned
      // where `a` first appeared (override updates in place).
      expect(runtime.read(mounts)).toEqual([
        {id: 'a', label: 'second'},
        {id: 'b', label: 'only-b'},
      ])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toContain('test.id-dedup')
      expect(warn.mock.calls[0]?.[0]).toContain('"a"')
    } finally {
      warn.mockRestore()
    }
  })

  it('resolves a same-id tie by precedence (higher precedence wins) regardless of registration order', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const runtime = resolveFacetRuntimeSync([
        mounts.of({id: 'a', label: 'high'}, {precedence: 10}),
        mounts.of({id: 'a', label: 'low'}, {precedence: 0}),
      ])

      // read() sorts ascending by precedence before combine, so the
      // higher-precedence contribution lands last and wins last-wins.
      expect(runtime.read(mounts)).toEqual([{id: 'a', label: 'high'}])
    } finally {
      warn.mockRestore()
    }
  })

  it('leaves a single contribution per id unchanged and does not warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const runtime = resolveFacetRuntimeSync([
        mounts.of({id: 'a', label: 'a'}),
        mounts.of({id: 'b', label: 'b'}),
      ])

      expect(runtime.read(mounts)).toEqual([
        {id: 'a', label: 'a'},
        {id: 'b', label: 'b'},
      ])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
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

// adoptDurableContributionsFrom is how a `setFacetRuntime` swap carries
// repo-owned user data (durable buckets) forward without a separate
// mirror (B1(2)). The durable/transient split is load-bearing: copying
// transient effect-owned buckets forward is exactly what stranded stale
// contributions and got reverted in #152, so it's covered directly.
describe('FacetRuntime.adoptDurableContributionsFrom', () => {
  const labelsFacet = defineFacet<string, string>({
    id: 'test.adopt-labels',
    combine: values => values.join(','),
    empty: () => '',
  })

  it('carries durable buckets onto the fresh runtime', () => {
    const previous = resolveFacetRuntimeSync([])
    previous.setRuntimeContributions(labelsFacet, 'user-data', ['schema'], { durable: true })

    const next = resolveFacetRuntimeSync([labelsFacet.of('static')])
    next.adoptDurableContributionsFrom(previous)
    expect(next.read(labelsFacet)).toBe('static,schema')
  })

  it('does NOT carry transient (non-durable) buckets — they would strand', () => {
    const previous = resolveFacetRuntimeSync([])
    previous.setRuntimeContributions(labelsFacet, 'effect-output', ['transient'])

    const next = resolveFacetRuntimeSync([labelsFacet.of('static')])
    next.adoptDurableContributionsFrom(previous)
    expect(next.read(labelsFacet)).toBe('static')
  })

  it('drops a durable bucket once cleared on the source runtime', () => {
    const previous = resolveFacetRuntimeSync([])
    previous.setRuntimeContributions(labelsFacet, 'user-data', ['schema'], { durable: true })
    previous.setRuntimeContributions(labelsFacet, 'user-data', [], { durable: true })

    const next = resolveFacetRuntimeSync([])
    next.adoptDurableContributionsFrom(previous)
    expect(next.read(labelsFacet)).toBe('')
  })

  it('stops treating a bucket as durable when re-set as transient', () => {
    const previous = resolveFacetRuntimeSync([])
    previous.setRuntimeContributions(labelsFacet, 'src', ['v'], { durable: true })
    previous.setRuntimeContributions(labelsFacet, 'src', ['v'])

    const next = resolveFacetRuntimeSync([])
    next.adoptDurableContributionsFrom(previous)
    expect(next.read(labelsFacet)).toBe('')
  })
})

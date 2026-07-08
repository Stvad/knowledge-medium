// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  ChangeScope,
  codecs,
  defineProperty,
  type AnyPropertySchema,
} from '@/data/api'
import { refTargetFilterDefaultsFacet, type RefTargetFilterDefault } from '@/data/facets.js'
import {
  DAILY_NOTE_TYPE,
  dailyNoteDateProp,
} from '@/plugins/daily-notes/schema.js'
import { BacklinkFilters } from '../BacklinkFilters.tsx'

const schemaStore = vi.hoisted(() => ({
  schemas: new Map<string, unknown>(),
  refTargetDefaults: new Map<string, unknown>(),
  // query → candidates, for the mocked ref search
  searchById: new Map<string, Array<{id: string; label: string; detail: string; key: string}>>(),
  aliasLookupResult: null as { id: string } | null,
}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => ({
    block: (id: string) => ({id}),
    query: {
      aliasLookup: () => ({load: async () => schemaStore.aliasLookupResult}),
    },
  }),
}))

vi.mock('@/utils/linkTargetAutocomplete.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  searchLinkTargetIdCandidates: vi.fn(
    async (_repo: unknown, {query}: {query: string}) => schemaStore.searchById.get(query) ?? [],
  ),
}))

vi.mock('@/hooks/block.ts', () => ({
  useHandle: (
    block: {id: string},
    opts: {selector: (value: {content: string; properties: Record<string, unknown>} | undefined) => string},
  ) => opts.selector({content: block.id, properties: {}}),
}))

vi.mock('@/hooks/propertySchemas.ts', () => ({
  usePropertySchemas: () => schemaStore.schemas,
}))

vi.mock('@/extensions/runtimeContext.ts', () => ({
  useAppRuntime: () => ({
    read: (facet: {id: string}) => {
      if (facet.id === refTargetFilterDefaultsFacet.id) return schemaStore.refTargetDefaults
      return new Map()
    },
  }),
}))

const setSchemas = (...schemas: AnyPropertySchema[]) => {
  schemaStore.schemas = new Map(schemas.map(schema => [schema.name, schema]))
  // Daily-note schema is needed when resolving any daily-note ref to
  // its inner date property's affordance.
  if (!schemaStore.schemas.has(dailyNoteDateProp.name)) {
    schemaStore.schemas.set(dailyNoteDateProp.name, dailyNoteDateProp)
  }
}

const setRefTargetDefaults = (...entries: RefTargetFilterDefault[]) => {
  schemaStore.refTargetDefaults = new Map(entries.map(e => [e.targetType, e]))
}

describe('BacklinkFilters', () => {
  beforeEach(() => {
    setSchemas()
    setRefTargetDefaults({
      targetType: DAILY_NOTE_TYPE,
      property: dailyNoteDateProp.name,
    })
    schemaStore.searchById = new Map()
    schemaStore.aliasLookupResult = null
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows a config action for displayed default filters', () => {
    const openConfig = vi.fn()

    render(
      <BacklinkFilters
        workspaceId="ws-1"
        filter={{}}
        baseFilter={{exclude: [{scope: 'ancestor', referencedBy: {id: 'done'}}]}}
        baseLabel="Daily note defaults"
        baseConfigLabel="Open daily note defaults"
        onBaseConfigClick={openConfig}
        onChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', {name: 'Open daily note defaults'}))

    expect(openConfig).toHaveBeenCalledOnce()
  })

  it('renders duplicate stored exclude predicates only once', () => {
    render(
      <BacklinkFilters
        workspaceId="ws-1"
        filter={{
          exclude: [
            {scope: 'ancestor', referencedBy: {id: 'done'}},
            {scope: 'ancestor', referencedBy: {id: 'done'}},
          ],
        }}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getAllByTitle('done')).toHaveLength(1)
  })

  it('allows set/unset filters for registered non-comparable properties', () => {
    const listProp = defineProperty<unknown[]>('roam:list', {
      codec: codecs.list(codecs.unsafeIdentity<unknown>()),
      defaultValue: [],
      changeScope: ChangeScope.BlockDefault,
    })
    setSchemas(listProp)
    const onChange = vi.fn()

    render(
      <BacklinkFilters
        workspaceId="ws-1"
        filter={{}}
        onChange={onChange}
      />,
    )

    fireEvent.change(screen.getByLabelText('Include property'), {
      target: {value: listProp.name},
    })

    const operator = screen.getByLabelText('operator') as HTMLSelectElement
    expect([...operator.options].map(option => option.textContent)).toEqual([
      'is set',
      'is unset',
    ])
    expect(screen.queryByLabelText('Include value')).toBeNull()

    fireEvent.click(screen.getByRole('button', {name: 'Add include property filter'}))

    expect(onChange).toHaveBeenCalledWith({
      include: [{scope: 'ancestor', where: {[listProp.name]: {exists: true}}}],
      exclude: [],
    })
  })

  it('treats daily-note refList properties as date-comparable via target traversal', () => {
    const initialReviewDateProp = defineProperty<readonly string[]>('roam:initial review date', {
      codec: codecs.refList({targetTypes: [DAILY_NOTE_TYPE]}),
      defaultValue: [],
      changeScope: ChangeScope.BlockDefault,
    })
    setSchemas(initialReviewDateProp)
    const onChange = vi.fn()

    render(
      <BacklinkFilters
        workspaceId="ws-1"
        filter={{}}
        onChange={onChange}
      />,
    )

    fireEvent.change(screen.getByLabelText('Include property'), {
      target: {value: initialReviewDateProp.name},
    })
    fireEvent.change(screen.getByLabelText('operator'), {
      target: {value: 'lt'},
    })
    const value = screen.getByLabelText('Include value') as HTMLInputElement
    expect(value.type).toBe('date')

    fireEvent.change(value, {target: {value: '2026-05-18'}})
    fireEvent.click(screen.getByRole('button', {name: 'Add include property filter'}))

    expect(onChange).toHaveBeenCalledWith({
      include: [{
        scope: 'ancestor',
        where: {
          [initialReviewDateProp.name]: {
            target: {
              [dailyNoteDateProp.name]: {
                lt: new Date('2026-05-18T00:00:00.000Z'),
              },
            },
          },
        },
      }],
      exclude: [],
    })
  })

  // Guards the resultsQuery staleness check wired into RefPredicateInput's
  // submit path (commit 41d5842b): mid-debounce, `results` still reflect the
  // previous text, so "+"/submit must honor what's typed, not the stale top hit.
  it('ref submit ignores mid-debounce stale results and honors the typed text', async () => {
    vi.useFakeTimers()
    schemaStore.searchById.set('ab', [{id: 'block-ab', label: 'ab match', detail: '', key: 'block-ab'}])
    schemaStore.aliasLookupResult = {id: 'alias-abc'}
    const onChange = vi.fn()

    render(<BacklinkFilters workspaceId="ws-1" filter={{}} onChange={onChange} />)
    const input = screen.getByPlaceholderText('Include reference')
    fireEvent.focus(input)
    fireEvent.change(input, {target: {value: 'ab'}})
    await act(async () => { await vi.advanceTimersByTimeAsync(100) }) // settle → results for 'ab'

    // Type ahead to 'abc' WITHOUT settling the debounce → results still 'ab'.
    fireEvent.change(input, {target: {value: 'abc'}})
    await act(async () => {
      fireEvent.click(screen.getByRole('button', {name: 'Add include filter'}))
      await vi.advanceTimersByTimeAsync(0) // flush the aliasLookup microtask
    })

    expect(onChange).toHaveBeenCalledWith({
      include: [{scope: 'ancestor', referencedBy: {id: 'alias-abc'}}],
      exclude: [],
    })
  })

  it('ref submit adopts the top result when it matches the typed text', async () => {
    vi.useFakeTimers()
    schemaStore.searchById.set('ab', [{id: 'block-ab', label: 'ab match', detail: '', key: 'block-ab'}])
    schemaStore.aliasLookupResult = {id: 'alias-unused'}
    const onChange = vi.fn()

    render(<BacklinkFilters workspaceId="ws-1" filter={{}} onChange={onChange} />)
    const input = screen.getByPlaceholderText('Include reference')
    fireEvent.focus(input)
    fireEvent.change(input, {target: {value: 'ab'}})
    await act(async () => { await vi.advanceTimersByTimeAsync(100) }) // settle → results for 'ab'

    await act(async () => {
      fireEvent.click(screen.getByRole('button', {name: 'Add include filter'}))
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(onChange).toHaveBeenCalledWith({
      include: [{scope: 'ancestor', referencedBy: {id: 'block-ab'}}],
      exclude: [],
    })
  })

  it('keyboard Enter ignores mid-debounce stale results and honors the typed text', async () => {
    vi.useFakeTimers()
    schemaStore.searchById.set('ab', [{id: 'block-ab', label: 'ab match', detail: '', key: 'block-ab'}])
    schemaStore.aliasLookupResult = {id: 'alias-abc'}
    const onChange = vi.fn()

    render(<BacklinkFilters workspaceId="ws-1" filter={{}} onChange={onChange} />)
    const input = screen.getByPlaceholderText('Include reference')
    fireEvent.focus(input)
    fireEvent.change(input, {target: {value: 'ab'}})
    await act(async () => { await vi.advanceTimersByTimeAsync(100) }) // settle → results for 'ab'

    fireEvent.change(input, {target: {value: 'abc'}}) // type ahead; results still 'ab'
    await act(async () => {
      fireEvent.keyDown(input, {key: 'Enter'})
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(onChange).toHaveBeenCalledWith({
      include: [{scope: 'ancestor', referencedBy: {id: 'alias-abc'}}],
      exclude: [],
    })
  })

  it('keyboard Enter adopts the highlighted result when fresh', async () => {
    vi.useFakeTimers()
    schemaStore.searchById.set('ab', [{id: 'block-ab', label: 'ab match', detail: '', key: 'block-ab'}])
    schemaStore.aliasLookupResult = {id: 'alias-unused'}
    const onChange = vi.fn()

    render(<BacklinkFilters workspaceId="ws-1" filter={{}} onChange={onChange} />)
    const input = screen.getByPlaceholderText('Include reference')
    fireEvent.focus(input)
    fireEvent.change(input, {target: {value: 'ab'}})
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })

    await act(async () => {
      fireEvent.keyDown(input, {key: 'Enter'})
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(onChange).toHaveBeenCalledWith({
      include: [{scope: 'ancestor', referencedBy: {id: 'block-ab'}}],
      exclude: [],
    })
  })

  it('clicking a visible suggestion commits that row even mid-debounce', async () => {
    vi.useFakeTimers()
    schemaStore.searchById.set('ab', [{id: 'block-ab', label: 'ab match', detail: '', key: 'block-ab'}])
    schemaStore.aliasLookupResult = {id: 'alias-abc'}
    const onChange = vi.fn()

    render(<BacklinkFilters workspaceId="ws-1" filter={{}} onChange={onChange} />)
    const input = screen.getByPlaceholderText('Include reference')
    fireEvent.focus(input)
    fireEvent.change(input, {target: {value: 'ab'}})
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })

    fireEvent.change(input, {target: {value: 'abc'}}) // stale: dropdown still shows 'ab match'
    await act(async () => {
      fireEvent.click(screen.getByText('ab match'))
      await vi.advanceTimersByTimeAsync(0)
    })

    // The clicked row wins regardless of staleness — click commits what's seen.
    expect(onChange).toHaveBeenCalledWith({
      include: [{scope: 'ancestor', referencedBy: {id: 'block-ab'}}],
      exclude: [],
    })
  })
})

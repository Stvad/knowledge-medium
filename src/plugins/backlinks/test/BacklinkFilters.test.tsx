// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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
}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => ({
    block: (id: string) => ({id}),
  }),
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
})

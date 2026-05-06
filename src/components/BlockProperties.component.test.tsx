// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  ChangeScope,
  codecs,
  defineBlockType,
  defineProperty,
} from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { typesFacet } from '@/data/facets'
import { resolveFacetRuntimeSync, type FacetRuntime } from '@/extensions/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { blockRenderersFacet } from '@/extensions/core'
import { BlockProperties } from './BlockProperties'
import { adhocSchema } from './propertyEditors/defaults'
import { requestPropertyCreate } from '@/utils/propertyNavigation'
import { typesPropertyUiExtension } from './propertyEditors/typesPropertyUi'
import type { Block } from '@/data/block'
import { aliasesProp } from '@/data/properties'
import { useContent } from '@/hooks/block'
import type { BlockRendererProps } from '@/types'

const repoRef = vi.hoisted(() => ({
  current: undefined as Repo | undefined,
}))
const uiStateBlockRef = vi.hoisted(() => ({
  current: undefined as Block | undefined,
}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!repoRef.current) throw new Error('test repo not initialised')
    return repoRef.current
  },
}))

vi.mock('@/data/globalState.ts', () => ({
  useUIStateBlock: () => {
    if (!uiStateBlockRef.current) throw new Error('test UI state block not initialised')
    return uiStateBlockRef.current
  },
}))

const reviewStatusProp = defineProperty<string>('phase2:review-status', {
  codec: codecs.string,
  defaultValue: 'open',
  changeScope: ChangeScope.BlockDefault,
  kind: 'string',
})

const reviewerRefProp = defineProperty<string>('phase2:reviewer-ref', {
  codec: codecs.ref({targetTypes: ['reviewer']}),
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
  kind: 'ref',
})

const relatedRefsProp = defineProperty<readonly string[]>('phase2:related-refs', {
  codec: codecs.refList({targetTypes: ['related']}),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
  kind: 'refList',
})

const reviewType = defineBlockType({
  id: 'phase2-review',
  label: 'Phase 2 Review',
  properties: [reviewStatusProp, reviewerRefProp, relatedRefsProp],
})

const reviewerProp = defineProperty<string>('phase2:reviewer', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
  kind: 'string',
})

const assignmentType = defineBlockType({
  id: 'phase2-assignment',
  label: 'Phase 2 Assignment',
  properties: [reviewerProp],
})

const TestBlockRenderer = ({block}: BlockRendererProps) => {
  const content = useContent(block)
  return <div>{content}</div>
}

describe('BlockProperties component', () => {
  let h: TestDb
  let repo: Repo
  let runtime: FacetRuntime

  beforeEach(async () => {
    h = await createTestDb()
    let now = 1700_000_000_000
    let idSeq = 0
    let txSeq = 0
    repo = new Repo({
      db: h.db,
      cache: new BlockCache(),
      user: {id: 'user-1'},
      now: () => ++now,
      newId: () => `generated-${++idSeq}`,
      newTxSeq: () => ++txSeq,
      startRowEventsTail: false,
    })
    runtime = resolveFacetRuntimeSync([
      kernelDataExtension,
      typesPropertyUiExtension,
      blockRenderersFacet.of({id: 'default', renderer: TestBlockRenderer}, {source: 'test'}),
      typesFacet.of(reviewType, {source: 'test'}),
      typesFacet.of(assignmentType, {source: 'test'}),
    ])
    repo.setFacetRuntime(runtime)
    repoRef.current = repo

    await repo.tx(async tx => {
      await tx.create({
        id: 'block-1',
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'a0',
      })
      await tx.create({
        id: 'ui-state',
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'a1',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'create test block'})
    await repo.addType('block-1', reviewType.id)
    uiStateBlockRef.current = repo.block('ui-state')
  })

  afterEach(async () => {
    cleanup()
    repoRef.current = undefined
    uiStateBlockRef.current = undefined
    await h.cleanup()
  })

  it('edits and materialises an unset type-contributed property slot', async () => {
    const block = repo.block('block-1')
    expect(block.peekProperty(reviewStatusProp)).toBeUndefined()

    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockProperties block={block}/>
      </AppRuntimeContextProvider>,
    )

    expect(screen.getByText('phase2:review-status')).toBeTruthy()

    const input = screen.getByDisplayValue('open')
    await act(async () => {
      fireEvent.change(input, {target: {value: 'done'}})
    })

    await waitFor(() => {
      expect(block.peekProperty(reviewStatusProp)).toBe('done')
    })
    expect(block.data.properties[reviewStatusProp.name]).toBe('done')
  })

  it('keeps hidden fields discoverable behind a toggle', async () => {
    const block = repo.block('block-1')

    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockProperties block={block}/>
      </AppRuntimeContextProvider>,
    )

    expect(screen.getByText('Types')).toBeTruthy()
    expect(screen.queryByText('types')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', {name: /show hidden fields/i}))
    })

    expect(screen.getByText('Hidden')).toBeTruthy()
    expect(screen.getByText('ID')).toBeTruthy()
    expect(screen.queryByText('types')).toBeNull()
  })

  it('edits block type membership with the contributed autocomplete editor', async () => {
    const block = repo.block('block-1')

    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockProperties block={block}/>
      </AppRuntimeContextProvider>,
    )

    expect(screen.getByText('Phase 2 Review')).toBeTruthy()

    const input = screen.getByRole('combobox', {name: /add block type/i})
    await act(async () => {
      fireEvent.change(input, {target: {value: 'assignment'}})
    })

    const listbox = screen.getByRole('listbox')
    expect(listbox.parentElement).toBe(document.body)
    expect(listbox.classList.contains('fixed')).toBe(true)

    await act(async () => {
      fireEvent.keyDown(input, {key: 'Enter'})
    })

    await waitFor(() => {
      expect(block.types).toEqual(['phase2-review', 'phase2-assignment'])
    })
    expect(screen.getByText('Phase 2 Assignment')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', {name: /remove phase 2 review type/i}))
    })

    await waitFor(() => {
      expect(block.types).toEqual(['phase2-assignment'])
    })
  })

  it('places hidden fields in the first group when revealed', async () => {
    const block = repo.block('block-1')
    await repo.addType(block.id, assignmentType.id)

    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockProperties block={block}/>
      </AppRuntimeContextProvider>,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', {name: /show hidden fields/i}))
    })

    const groups = screen.getAllByText(/^(Hidden|# Phase 2 Review|# Phase 2 Assignment)$/)
    expect(groups.map(group => group.textContent)).toEqual([
      'Hidden',
      '# Phase 2 Review',
      '# Phase 2 Assignment',
    ])
  })

  it('opens field configuration from the type icon', async () => {
    const block = repo.block('block-1')

    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockProperties block={block}/>
      </AppRuntimeContextProvider>,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', {name: /configure phase2:review-status/i}))
    })

    expect(screen.getByRole('dialog', {name: /phase2:review-status field configuration/i})).toBeTruthy()
    expect(screen.getByText('Field type')).toBeTruthy()
    expect(screen.getByText('Registered field')).toBeTruthy()
    expect(screen.queryByText('Storage key')).toBeNull()
    expect(screen.queryByText('Hide field')).toBeNull()
    expect(screen.queryByText('Required')).toBeNull()
  })

  it('persists field type changes for ad-hoc properties', async () => {
    const block = repo.block('block-1')
    await block.set(adhocSchema('mood', 'string'), 'ok')

    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockProperties block={block}/>
      </AppRuntimeContextProvider>,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', {name: /configure mood/i}))
    })

    const typeSelect = screen.getByRole('combobox', {name: /mood field type/i}) as HTMLSelectElement
    await act(async () => {
      fireEvent.change(typeSelect, {target: {value: 'number'}})
    })

    await waitFor(() => {
      expect(block.data.properties.mood).toBe(0)
    })
    await waitFor(() => {
      expect((screen.getByRole('combobox', {name: /mood field type/i}) as HTMLSelectElement).value)
        .toBe('number')
    })
    expect(screen.getByDisplayValue('0')).toBeTruthy()
  })

  it('moves between property values and labels without selecting row controls', async () => {
    const block = repo.block('block-1')

    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockProperties block={block}/>
      </AppRuntimeContextProvider>,
    )

    const statusRow = propertyRow(reviewStatusProp.name)
    const reviewerRow = propertyRow(reviewerRefProp.name)
    const statusValue = within(statusRow).getByDisplayValue('open')
    const reviewerLabel = within(reviewerRow).getByText('phase2:reviewer-ref')
    const reviewerConfig = within(reviewerRow)
      .getByRole('button', {name: /configure phase2:reviewer-ref/i})

    statusValue.focus()
    await act(async () => {
      fireEvent.keyDown(statusValue, {key: 'ArrowDown'})
    })

    expect(document.activeElement).toBe(reviewerLabel)
    expect(document.activeElement).not.toBe(reviewerConfig)

    await act(async () => {
      fireEvent.keyDown(reviewerLabel, {key: 'ArrowUp'})
    })

    expect(document.activeElement).toBe(statusValue)
  })

  it('keeps fields visually grouped by contributing type when multiple types apply', async () => {
    const block = repo.block('block-1')
    await repo.addType(block.id, assignmentType.id)

    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockProperties block={block}/>
      </AppRuntimeContextProvider>,
    )

    expect(screen.getByText('# Phase 2 Review')).toBeTruthy()
    expect(screen.getByText('phase2:review-status')).toBeTruthy()
    expect(screen.getByText('# Phase 2 Assignment')).toBeTruthy()
    expect(screen.getByText('phase2:reviewer')).toBeTruthy()
  })

  it('opens property creation from a Tana-style request and tabs into the value row', async () => {
    const block = repo.block('block-1')

    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockProperties block={block}/>
      </AppRuntimeContextProvider>,
    )

    await act(async () => {
      requestPropertyCreate({blockId: block.id})
    })

    const fieldInput = screen.getByPlaceholderText('Field')
    await act(async () => {
      fireEvent.change(fieldInput, {target: {value: 'mood'}})
      fireEvent.keyDown(fieldInput, {key: 'Tab'})
    })

    await waitFor(() => {
      expect(block.data.properties.mood).toBe('')
    })
    await waitFor(() => {
      const moodInput = document.querySelector<HTMLInputElement>(
        '[data-property-name="mood"] [data-property-value="true"] input',
      )
      expect(document.activeElement).toBe(moodInput)
    })
  })

  it('opens block search autocomplete for an empty ref field', async () => {
    await repo.tx(async tx => {
      await tx.create({
        id: 'target-alias',
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'b0',
        content: 'Aliased target content',
        properties: {
          [aliasesProp.name]: aliasesProp.codec.encode(['Target Alias']),
        },
      })
      await tx.create({
        id: 'target-recent',
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'b1',
        content: 'Recent target content',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'create target alias'})

    const block = repo.block('block-1')

    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockProperties block={block}/>
      </AppRuntimeContextProvider>,
    )

    const row = propertyRow(reviewerRefProp.name)
    const input = within(row).getByRole('combobox', {name: /search block reference/i})

    await act(async () => {
      fireEvent.focus(input)
    })

    expect(await within(row).findByRole('option', {name: /Target Alias/})).toBeTruthy()
    expect(await within(row).findByRole('option', {name: /Recent target content/})).toBeTruthy()
  })

  it('stores a searched ref target and renders it as a block embed', async () => {
    await repo.tx(async tx => {
      await tx.create({
        id: 'target-ref',
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'b0',
        content: 'Target ref block',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'create target ref'})

    const block = repo.block('block-1')

    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockProperties block={block}/>
      </AppRuntimeContextProvider>,
    )

    const row = propertyRow(reviewerRefProp.name)
    const input = within(row).getByRole('combobox', {name: /search block reference/i})

    await act(async () => {
      fireEvent.change(input, {target: {value: 'Target ref'}})
    })

    const option = await within(row).findByRole('option', {name: /Target ref block/})
    await act(async () => {
      fireEvent.click(option)
    })

    await waitFor(() => {
      expect(block.peekProperty(reviewerRefProp)).toBe('target-ref')
    })
    await waitFor(() => {
      const nextRow = propertyRow(reviewerRefProp.name)
      expect(nextRow.querySelector('.blockembed')).toBeTruthy()
      expect(within(nextRow).getByText('Target ref block')).toBeTruthy()
    })
  })

  it('adds searched ref-list targets and renders them as block embeds', async () => {
    await repo.tx(async tx => {
      await tx.create({
        id: 'target-related',
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'b0',
        content: 'Related target block',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'create related target'})

    const block = repo.block('block-1')

    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockProperties block={block}/>
      </AppRuntimeContextProvider>,
    )

    const row = propertyRow(relatedRefsProp.name)
    const input = within(row).getByRole('combobox', {name: /search block reference/i})

    await act(async () => {
      fireEvent.change(input, {target: {value: 'Related target'}})
    })

    const option = await within(row).findByRole('option', {name: /Related target block/})
    await act(async () => {
      fireEvent.click(option)
    })

    await waitFor(() => {
      expect(block.peekProperty(relatedRefsProp)).toEqual(['target-related'])
    })
    await waitFor(() => {
      const nextRow = propertyRow(relatedRefsProp.name)
      expect(nextRow.querySelectorAll('.blockembed')).toHaveLength(1)
      expect(within(nextRow).getByText('Related target block')).toBeTruthy()
    })
  })
})

const propertyRow = (propertyName: string): HTMLElement => {
  const row = document.querySelector<HTMLElement>(`[data-property-name="${propertyName}"]`)
  expect(row).toBeTruthy()
  return row as HTMLElement
}

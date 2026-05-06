// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import { BlockProperties } from './BlockProperties'
import { requestPropertyCreate } from '@/utils/propertyNavigation'
import type { Block } from '@/data/block'

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

const reviewType = defineBlockType({
  id: 'phase2-review',
  label: 'Phase 2 Review',
  properties: [reviewStatusProp],
})

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
      typesFacet.of(reviewType, {source: 'test'}),
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

    expect(screen.getByText('Phase 2 Review')).toBeTruthy()
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

    expect(screen.queryByText('types')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', {name: /show hidden fields/i}))
    })

    expect(screen.getByText('Hidden')).toBeTruthy()
    expect(screen.getByText('ID')).toBeTruthy()
    expect(screen.getByText('types')).toBeTruthy()
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
      expect(document.activeElement).toBe(screen.getByDisplayValue(''))
    })
  })
})

// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { Check, ClockArrowDown, Gauge, RotateCcw, Sparkles } from 'lucide-react'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { Repo } from '@/data/repo'
import { createTestDb } from '@/data/test/createTestDb'
import { actionsFacet } from '@/extensions/core.ts'
import { blockContentSurfacePropsFacet } from '@/extensions/blockInteraction.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { propertySchemasFacet, typesFacet } from '@/data/facets.ts'
import { ActionConfig, ActionContextTypes } from '@/shortcuts/types.ts'
import { dailyNotesDataExtension } from '@/plugins/daily-notes'
import { quickActionItemsFacet } from '@/plugins/swipe-quick-actions'
import {
  SRS_SM25_TYPE,
  srsArchivedProp,
  srsFactorProp,
  srsGradeProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReschedulingPlugin,
  srsReviewCountProp,
  srsSnapshotHistoryProp,
} from '../index.ts'

describe('srsReschedulingPlugin', () => {
  it('contributes the SRS SM-2.5 type and property schemas', () => {
    const runtime = resolveFacetRuntimeSync(srsReschedulingPlugin)
    const schemas = runtime.read(propertySchemasFacet)
    const types = runtime.read(typesFacet)

    expect(schemas.get(srsIntervalProp.name)).toBe(srsIntervalProp)
    expect(schemas.get(srsFactorProp.name)).toBe(srsFactorProp)
    expect(schemas.get(srsNextReviewDateProp.name)).toBe(srsNextReviewDateProp)
    expect(schemas.get(srsReviewCountProp.name)).toBe(srsReviewCountProp)
    expect(schemas.get(srsGradeProp.name)).toBe(srsGradeProp)
    expect(schemas.get(srsArchivedProp.name)).toBe(srsArchivedProp)
    expect(schemas.get(srsSnapshotHistoryProp.name)).toBe(srsSnapshotHistoryProp)
    expect(types.get(SRS_SM25_TYPE)?.properties).toEqual([
      srsIntervalProp,
      srsFactorProp,
      srsNextReviewDateProp,
      srsReviewCountProp,
      srsGradeProp,
      srsArchivedProp,
      srsSnapshotHistoryProp,
    ])
  })

  it('contributes matching shortcuts in normal and edit mode', () => {
    const runtime = resolveFacetRuntimeSync(srsReschedulingPlugin)
    const actions = runtime.read(actionsFacet)

    expect(actions).toHaveLength(10)
    expect(actions.map(action => action.context)).toEqual([
      ActionContextTypes.NORMAL_MODE,
      ActionContextTypes.NORMAL_MODE,
      ActionContextTypes.NORMAL_MODE,
      ActionContextTypes.NORMAL_MODE,
      ActionContextTypes.NORMAL_MODE,
      ActionContextTypes.EDIT_MODE_CM,
      ActionContextTypes.EDIT_MODE_CM,
      ActionContextTypes.EDIT_MODE_CM,
      ActionContextTypes.EDIT_MODE_CM,
      ActionContextTypes.EDIT_MODE_CM,
    ])

    expect(actions.map(action => action.defaultBinding?.keys)).toEqual([
      ['ctrl+shift+1', 'ctrl+shift+alt+cmd+1'],
      ['ctrl+shift+2', 'ctrl+shift+alt+cmd+2'],
      ['ctrl+shift+3', 'ctrl+shift+alt+cmd+3'],
      ['ctrl+shift+4', 'ctrl+shift+alt+cmd+4'],
      ['ctrl+shift+5', 'ctrl+shift+alt+cmd+5'],
      ['ctrl+shift+1', 'ctrl+shift+alt+cmd+1'],
      ['ctrl+shift+2', 'ctrl+shift+alt+cmd+2'],
      ['ctrl+shift+3', 'ctrl+shift+alt+cmd+3'],
      ['ctrl+shift+4', 'ctrl+shift+alt+cmd+4'],
      ['ctrl+shift+5', 'ctrl+shift+alt+cmd+5'],
    ])
    expect(actions.slice(0, 5).map(action => action.icon)).toEqual([
      RotateCcw,
      Gauge,
      Check,
      Sparkles,
      ClockArrowDown,
    ])
    expect(actions.slice(5).map(action => action.icon)).toEqual([
      RotateCcw,
      Gauge,
      Check,
      Sparkles,
      ClockArrowDown,
    ])
  })

  it('contributes swipe quick actions and block decoration hook for SRS blocks', () => {
    const runtime = resolveFacetRuntimeSync(srsReschedulingPlugin)
    const items = runtime.read(quickActionItemsFacet)

    expect(items.map(item => [item.actionId, item.row ?? 1])).toEqual([
      ['srs.reschedule.again', 2],
      ['srs.reschedule.hard', 2],
      ['srs.reschedule.good', 2],
      ['srs.reschedule.easy', 2],
      ['srs.reschedule.sooner', 2],
    ])
    expect(runtime.contributions(blockContentSurfacePropsFacet)).toHaveLength(1)
  })

  it('does not rewrite legacy inline SRS content from edit mode', async () => {
    const h = await createTestDb()
    try {
      let now = 1700_000_000_000
      let id = 0
      const repo = new Repo({
        db: h.db,
        cache: new BlockCache(),
        user: {id: 'user-1'},
        now: () => ++now,
        newId: () => `generated-${++id}`,
        registerKernelProcessors: false,
      })
      const runtime = resolveFacetRuntimeSync([
        kernelDataExtension,
        dailyNotesDataExtension,
        srsReschedulingPlugin,
      ])
      repo.setFacetRuntime(runtime)
      await repo.tx(async tx => {
        await tx.create({
          id: 'legacy-inline-srs',
          workspaceId: 'ws-1',
          parentId: null,
          orderKey: 'a0',
          content: 'Review [[May 1st, 2026]]',
        })
      }, {scope: ChangeScope.BlockDefault, description: 'seed legacy inline srs'})

      const action = runtime.read(actionsFacet).find(it =>
        it.id === 'edit.cm.srs.reschedule.good',
      ) as ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM>
      const block = repo.block('legacy-inline-srs')
      await block.load()
      const editorView = {dispatch: vi.fn()}

      await action.handler({
        block,
        uiStateBlock: block,
        editorView,
      } as never, {} as KeyboardEvent)

      expect(editorView.dispatch).not.toHaveBeenCalled()
      expect(block.data.content).toBe('Review [[May 1st, 2026]]')
      expect(block.types).toContain(SRS_SM25_TYPE)
    } finally {
      await h.cleanup()
    }
  })
})

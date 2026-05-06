import { describe, expect, it, vi } from 'vitest'
import { actionsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { propertySchemasFacet, propertyUiFacet, typesFacet } from '@/data/facets.ts'
import { ActionConfig, ActionContextTypes } from '@/shortcuts/types.ts'
import {
  SRS_SM25_TYPE,
  srsFactorProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsNextReviewDateUi,
  srsReschedulingPlugin,
  srsReviewCountProp,
} from '../index.ts'

describe('srsReschedulingPlugin', () => {
  it('contributes the SRS SM-2.5 type and property schemas', () => {
    const runtime = resolveFacetRuntimeSync(srsReschedulingPlugin)
    const schemas = runtime.read(propertySchemasFacet)
    const uis = runtime.read(propertyUiFacet)
    const types = runtime.read(typesFacet)

    expect(schemas.get(srsIntervalProp.name)).toBe(srsIntervalProp)
    expect(schemas.get(srsFactorProp.name)).toBe(srsFactorProp)
    expect(schemas.get(srsNextReviewDateProp.name)).toBe(srsNextReviewDateProp)
    expect(uis.get(srsNextReviewDateProp.name)).toBe(srsNextReviewDateUi)
    expect(schemas.get(srsReviewCountProp.name)).toBe(srsReviewCountProp)
    expect(types.get(SRS_SM25_TYPE)?.properties).toEqual([
      srsIntervalProp,
      srsFactorProp,
      srsNextReviewDateProp,
      srsReviewCountProp,
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
  })

  it('writes block data directly from edit mode', async () => {
    const runtime = resolveFacetRuntimeSync(srsReschedulingPlugin)
    const action = runtime.read(actionsFacet).find(it =>
      it.id === 'edit.cm.srs.reschedule.good',
    ) as ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM>
    const setContent = vi.fn()
    const block = {
      repo: {isReadOnly: false},
      peek: () => ({content: 'Review [[May 1st, 2026]]', properties: {}}),
      load: vi.fn(),
      setContent,
    }
    const editorView = {dispatch: vi.fn()}

    await action.handler({
      block,
      uiStateBlock: block,
      editorView,
    } as never, new KeyboardEvent('keydown'))

    expect(editorView.dispatch).not.toHaveBeenCalled()
    expect(setContent).toHaveBeenCalledTimes(1)
    expect(setContent.mock.calls[0][0]).toContain('[[[[interval]]:')
  })
})

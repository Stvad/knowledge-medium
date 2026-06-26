import { describe, expect, it } from 'vitest'
import { ChangeScope, codecs, defineProperty, type AnyPropertySchema } from '@/data/api'
import { isPropertyPanelHiddenProperty } from './visibility'

const prop = (name: string, changeScope: ChangeScope): AnyPropertySchema =>
  defineProperty<string | undefined>(name, {
    codec: codecs.optionalString,
    defaultValue: undefined,
    changeScope,
  })

describe('isPropertyPanelHiddenProperty', () => {
  // The defining contract of the Automation scope: it's surfaced in the panel
  // (so app/automation records are inspectable), unlike UiState which stays hidden.
  it('shows Automation-scoped properties but hides UiState ones', () => {
    const sys = prop('startupRecord', ChangeScope.Automation)
    const ui = prop('selectionState', ChangeScope.UiState)
    const schemas = new Map([[sys.name, sys], [ui.name, ui]])
    const uis = new Map()

    expect(isPropertyPanelHiddenProperty('startupRecord', schemas, uis)).toBe(false)
    expect(isPropertyPanelHiddenProperty('selectionState', schemas, uis)).toBe(true)
  })

  it('still hides system:-prefixed names regardless of scope', () => {
    const sys = prop('system:internal', ChangeScope.Automation)
    const schemas = new Map([[sys.name, sys]])
    expect(isPropertyPanelHiddenProperty('system:internal', schemas, new Map())).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { ChangeScope, codecs, defineProperty, type AnyPropertySchema } from '@/data/api'
import {buildPropertyDefinitionRegistry} from '@/data/propertyDefinitionRegistry'
import type {PropertyDefinitionMetadata} from '@/data/propertyDefinitionMetadata'
import {seedProperty} from '@/data/propertySeeds'
import { isPropertyPanelHiddenProperty } from './visibility'

const metadata = (
  fieldId: string,
  name: string,
  createdAt: number,
  hidden: boolean,
): PropertyDefinitionMetadata => ({
  fieldId,
  workspaceId: 'ws',
  createdAt,
  name,
  changeScope: ChangeScope.BlockDefault,
  hidden,
  origin: 'user',
})

const hiddenSeed = (seedKey: string, name = 'secret') => seedProperty({
  seedKey,
  revision: 1,
  name,
  preset: 'string',
  changeScope: ChangeScope.BlockDefault,
  hidden: true,
})

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

  it('uses the projected definition winner before seed metadata', () => {
    const schema = prop('secret', ChangeScope.BlockDefault)
    const visibleWinner = metadata('first', schema.name, 1, false)
    const hiddenLoser = metadata('second', schema.name, 2, true)
    const snapshot = buildPropertyDefinitionRegistry({
      workspaceId: 'ws',
      legacySchemas: new Map([[schema.name, schema]]),
      projectedDefinitions: new Map([
        [hiddenLoser.fieldId, {metadata: hiddenLoser}],
        [visibleWinner.fieldId, {metadata: visibleWinner}],
      ]),
      seeds: [hiddenSeed('plugin:test/property/secret')],
    })

    expect(isPropertyPanelHiddenProperty(schema.name, snapshot.schemas, new Map(), snapshot))
      .toBe(false)

    const hiddenWinnerSnapshot = buildPropertyDefinitionRegistry({
      workspaceId: 'ws',
      legacySchemas: new Map([[schema.name, schema]]),
      projectedDefinitions: new Map([
        [visibleWinner.fieldId, {metadata: {...visibleWinner, createdAt: 2}}],
        [hiddenLoser.fieldId, {metadata: {...hiddenLoser, createdAt: 1}}],
      ]),
      seeds: [],
    })
    expect(isPropertyPanelHiddenProperty(
      schema.name,
      hiddenWinnerSnapshot.schemas,
      new Map(),
      hiddenWinnerSnapshot,
    )).toBe(true)
  })

  it('hides a unique synthesized seed but not an ambiguous same-name declaration', () => {
    const unique = hiddenSeed('plugin:one/property/secret')
    const uniqueSnapshot = buildPropertyDefinitionRegistry({
      workspaceId: 'ws',
      legacySchemas: new Map(),
      projectedDefinitions: new Map(),
      seeds: [unique],
    })
    expect(isPropertyPanelHiddenProperty(unique.name, uniqueSnapshot.schemas, new Map(), uniqueSnapshot))
      .toBe(true)

    const ambiguousSnapshot = buildPropertyDefinitionRegistry({
      workspaceId: 'ws',
      legacySchemas: new Map(),
      projectedDefinitions: new Map(),
      seeds: [unique, hiddenSeed('plugin:two/property/secret')],
    })
    expect(isPropertyPanelHiddenProperty(unique.name, ambiguousSnapshot.schemas, new Map(), ambiguousSnapshot))
      .toBe(false)
  })

  it('uses the declaration carried by stage-0 synthesis when no registry is bound', () => {
    const hidden = hiddenSeed('plugin:stage-zero/property/secret')
    const schemas = new Map([[hidden.name, hidden]])

    expect(isPropertyPanelHiddenProperty(hidden.name, schemas, new Map(), null)).toBe(true)
  })
})

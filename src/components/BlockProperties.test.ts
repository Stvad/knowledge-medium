// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  ChangeScope,
  codecs,
  defineProperty,
  type AnyPropertySchema,
  type TypeContribution,
} from '@/data/api'
import { BLOCK_TYPE_TYPE, KERNEL_TYPE_CONTRIBUTIONS } from '@/data/blockTypes'
import {
  blockTypeHideFromBlockDisplayProp,
  blockTypeHideFromCompletionProp,
} from '@/data/properties'
import { buildPropertyPanelSections } from './propertyPanelSections'

const statusProp = defineProperty<string>('status', {
  codec: codecs.string,
  defaultValue: 'open',
  changeScope: ChangeScope.BlockDefault,
})

const dueProp = defineProperty<string>('due', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

const ownerProp = defineProperty<string>('owner', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

const priorityProp = defineProperty<number>('priority', {
  codec: codecs.number,
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})

const schemasMap = (schemas: readonly AnyPropertySchema[]) =>
  new Map(schemas.map(schema => [schema.name, schema]))

const typesMap = (types: readonly TypeContribution[]) =>
  new Map(types.map(type => [type.id, type]))

describe('buildPropertyPanelSections', () => {
  it('surfaces unset type-contributed slots in type-declared order', () => {
    const taskType = {
      id: 'task',
      label: 'Task',
      properties: [dueProp, statusProp],
    }

    const sections = buildPropertyPanelSections({
      properties: {status: 'done'},
      blockTypes: ['task'],
      typesRegistry: typesMap([taskType]),
      schemas: schemasMap([statusProp, dueProp]),
    })

    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({id: 'type:task', label: 'Task'})
    expect(sections[0].rows.map(row => [row.name, row.isSet])).toEqual([
      ['due', false],
      ['status', true],
    ])
  })

  it('surfaces the real block-type display toggles (incl. hide-from-completion) as editable unset rows', () => {
    // Guards the discoverability wiring for a `block-type` block: the panel
    // "Type" section is driven by `BLOCK_TYPE_TYPE.properties`, so a display
    // toggle only reaches the user when it's listed there. Drive the REAL
    // kernel contribution + its declared schemas so dropping a toggle from
    // that list (or breaking the seed prop) fails here. `hide-from-completion`
    // is the field this test exists to protect; its sibling
    // `hide-from-block-display` is asserted alongside as the paired invariant.
    const blockTypeContribution = KERNEL_TYPE_CONTRIBUTIONS.find(t => t.id === BLOCK_TYPE_TYPE)
    expect(blockTypeContribution).toBeDefined()

    const sections = buildPropertyPanelSections({
      properties: {}, // a freshly-minted block-type block sets no display flags
      blockTypes: [BLOCK_TYPE_TYPE],
      typesRegistry: typesMap([blockTypeContribution!]),
      schemas: schemasMap(blockTypeContribution!.properties ?? []),
    })

    expect(sections).toHaveLength(1)
    const rowByName = new Map(sections[0].rows.map(row => [row.name, row]))
    for (const prop of [blockTypeHideFromCompletionProp, blockTypeHideFromBlockDisplayProp]) {
      const row = rowByName.get(prop.name)
      expect(row, `${prop.name} must surface as a panel row`).toBeDefined()
      expect(row!.isSet).toBe(false)
    }
  })

  it('dedupes shared fields under the first contributing type in block type order', () => {
    const taskType = {
      id: 'task',
      label: 'Task',
      properties: [statusProp, dueProp],
    }
    const projectType = {
      id: 'project',
      label: 'Project',
      properties: [statusProp, ownerProp],
    }

    const sections = buildPropertyPanelSections({
      properties: {
        status: 'done',
        owner: 'Ada',
      },
      blockTypes: ['task', 'project'],
      typesRegistry: typesMap([taskType, projectType]),
      schemas: schemasMap([statusProp, dueProp, ownerProp]),
    })

    expect(sections.map(section => [section.id, section.rows.map(row => row.name)])).toEqual([
      ['type:task', ['status', 'due']],
      ['type:project', ['owner']],
    ])
  })

  it('keeps known non-type fields in Other and unknown set fields in Unregistered', () => {
    const taskType = {
      id: 'task',
      label: 'Task',
      properties: [statusProp],
    }

    const sections = buildPropertyPanelSections({
      properties: {
        status: 'open',
        priority: 2,
        rogue: ['x'],
      },
      blockTypes: ['task'],
      typesRegistry: typesMap([taskType]),
      schemas: schemasMap([statusProp, priorityProp]),
    })

    expect(sections.map(section => [section.id, section.rows.map(row => row.name)])).toEqual([
      ['type:task', ['status']],
      ['other', ['priority']],
      ['unregistered', ['rogue']],
    ])
  })
})

// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  ChangeScope,
  codecs,
  defineBlockType,
  defineProperty,
  type AnyPropertySchema,
  type TypeContribution,
} from '@/data/api'
import { buildPropertyPanelSections } from './propertyPanelSections'

const statusProp = defineProperty<string>('status', {
  codec: codecs.string,
  defaultValue: 'open',
  changeScope: ChangeScope.BlockDefault,
  kind: 'string',
})

const dueProp = defineProperty<string>('due', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
  kind: 'string',
})

const ownerProp = defineProperty<string>('owner', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
  kind: 'string',
})

const priorityProp = defineProperty<number>('priority', {
  codec: codecs.number,
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
  kind: 'number',
})

const schemasMap = (schemas: readonly AnyPropertySchema[]) =>
  new Map(schemas.map(schema => [schema.name, schema]))

const typesMap = (types: readonly TypeContribution[]) =>
  new Map(types.map(type => [type.id, type]))

describe('buildPropertyPanelSections', () => {
  it('surfaces unset type-contributed slots and orders set rows before unset rows', () => {
    const taskType = defineBlockType({
      id: 'task',
      label: 'Task',
      properties: [dueProp, statusProp],
    })

    const sections = buildPropertyPanelSections({
      properties: {status: 'done'},
      blockTypes: ['task'],
      typesRegistry: typesMap([taskType]),
      schemas: schemasMap([statusProp, dueProp]),
    })

    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({id: 'type:task', label: 'Task'})
    expect(sections[0].rows.map(row => [row.name, row.isSet])).toEqual([
      ['status', true],
      ['due', false],
    ])
  })

  it('dedupes shared fields under the first contributing type in block type order', () => {
    const taskType = defineBlockType({
      id: 'task',
      label: 'Task',
      properties: [statusProp, dueProp],
    })
    const projectType = defineBlockType({
      id: 'project',
      label: 'Project',
      properties: [statusProp, ownerProp],
    })

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
    const taskType = defineBlockType({
      id: 'task',
      label: 'Task',
      properties: [statusProp],
    })

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

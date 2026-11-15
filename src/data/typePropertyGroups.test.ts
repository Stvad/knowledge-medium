// @vitest-environment node
import {describe, expect, it} from 'vitest'
import {ChangeScope, codecs, defineProperty, type TypeContribution} from './api'
import {typePropertyGroups} from './typePropertyGroups'

const field = (name: string) => defineProperty(name, {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

describe('typePropertyGroups', () => {
  it('uses active schemas in declared order, preserving shared declarations for caller-specific deduplication', () => {
    const first = field('first')
    const shared = field('shared')
    const missing = field('missing')
    const activeShared = {...shared, defaultValue: 'active'}
    const types = new Map<string, TypeContribution>([
      ['first-type', {id: 'first-type', properties: [first, missing, shared]}],
      ['second-type', {id: 'second-type', properties: [shared, first]}],
    ])
    const groups = [...typePropertyGroups(
      ['missing-type', 'second-type', 'first-type', 'second-type'],
      types,
      new Map([[first.name, first], [shared.name, activeShared]]),
    )]
    expect(groups.map(group => [group.typeId, group.fields.map(({declaration}) => declaration.name)])).toEqual([
      ['second-type', ['shared', 'first']],
      ['first-type', ['first', 'shared']],
    ])
    expect(groups[0].contribution).toBe(types.get('second-type'))
    expect(groups[0].fields[0]).toEqual({declaration: shared, schema: activeShared})
  })
})

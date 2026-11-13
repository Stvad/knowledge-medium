import {
  ChangeScope,
  seedProperty,
  seedType,
} from '@/data/api'

export const TODO_TYPE = 'todo'

export type TodoStatus = 'open' | 'done'

export const statusProp = seedProperty<TodoStatus>({
  seedKey: 'system:todo/property/status',
  revision: 1,
  name: 'status',
  preset: 'strict-enum',
  config: {options: [
    {value: 'open', label: 'open'},
    {value: 'done', label: 'done'},
  ]},
  defaultValue: 'open',
  changeScope: ChangeScope.BlockDefault,
  hideInOutline: true,
})

export const todoType = seedType({
  seedKey: 'system:todo/type/todo',
  revision: 1,
  id: TODO_TYPE,
  label: 'Todo',
  // The checkbox renderer already conveys todo-ness on every todo
  // block — a trailing #Todo tag chip would be pure duplication. Still
  // taggable via # and fully visible in the property panel.
  hideFromBlockDisplay: true,
  properties: [statusProp],
})

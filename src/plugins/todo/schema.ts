import {
  ChangeScope,
  CodecError,
  defineBlockType,
  defineProperty,
  type Codec,
} from '@/data/api'

export const TODO_TYPE = 'todo'

export type TodoStatus = 'open' | 'done'
export type RoamTodoState = 'TODO' | 'DONE'

const literalCodec = <T extends string>(
  expected: readonly T[],
  label: string,
): Codec<T> => ({
  // Falls under the kernel `'string'` preset for editor selection;
  // values are constrained at encode/decode by `expected`. Also opts
  // into `where` since the storage form is a scalar string.
  type: 'string',
  encode: value => {
    if (!expected.includes(value)) throw new CodecError(label, value)
    return value
  },
  decode: json => {
    if (typeof json !== 'string' || !expected.includes(json as T)) {
      throw new CodecError(label, json)
    }
    return json as T
  },
  where: {
    encode: value => {
      if (typeof value !== 'string' || !expected.includes(value as T)) {
        throw new CodecError(label, value)
      }
      return value as string
    },
  },
})

export const statusProp = defineProperty<TodoStatus>('status', {
  codec: literalCodec<TodoStatus>(['open', 'done'], 'todo status'),
  defaultValue: 'open',
  changeScope: ChangeScope.BlockDefault,
})

export const roamTodoStateProp = defineProperty<RoamTodoState>('roam:todo-state', {
  codec: literalCodec<RoamTodoState>(['TODO', 'DONE'], 'Roam todo state'),
  defaultValue: 'TODO',
  changeScope: ChangeScope.BlockDefault,
})

export const todoType = defineBlockType({
  id: TODO_TYPE,
  label: 'Todo',
  properties: [statusProp],
})

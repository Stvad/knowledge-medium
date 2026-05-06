/* eslint-disable react-refresh/only-export-components */
import type { ComponentType } from 'react'
import type { Block } from '@/data/block'
import { typesProp } from '@/data/properties.ts'
import {
  blockContentDecoratorsFacet,
  type BlockContentDecorator,
  type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { usePropertyValue } from '@/hooks/block.ts'
import type { BlockRenderer, BlockRendererProps } from '@/types.ts'
import { todoDataExtension } from './dataExtension.ts'
import { statusProp, TODO_TYPE, type TodoStatus } from './schema.ts'

interface TodoContentDecoratorProps extends BlockRendererProps {
  Inner: BlockRenderer
}

const nextStatus = (checked: boolean): TodoStatus =>
  checked ? 'done' : 'open'

const TodoContentDecorator = ({block, Inner}: TodoContentDecoratorProps) => {
  const [types] = usePropertyValue(block, typesProp)
  const [status, setStatus] = usePropertyValue(block, statusProp)
  const isTodo = types.includes(TODO_TYPE)

  if (!isTodo) return <Inner block={block}/>

  const done = status === 'done'

  return (
    <div className="flex items-start gap-2">
      <input
        aria-label={done ? 'Mark todo open' : 'Mark todo done'}
        type="checkbox"
        checked={done}
        disabled={block.repo.isReadOnly}
        data-block-interaction="ignore"
        className="mt-1 h-4 w-4 shrink-0 rounded border-border accent-primary"
        onClick={event => event.stopPropagation()}
        onChange={event => {
          event.stopPropagation()
          void setStatus(nextStatus(event.currentTarget.checked))
        }}
      />
      <div className={done ? 'min-w-0 flex-1 text-muted-foreground line-through' : 'min-w-0 flex-1'}>
        <Inner block={block}/>
      </div>
    </div>
  )
}

const todoDecoratorCache = new WeakMap<BlockRenderer, BlockRenderer>()

const decorateTodoContent: BlockContentDecorator = inner => {
  const cached = todoDecoratorCache.get(inner)
  if (cached) return cached

  const Decorated: ComponentType<{block: Block}> = ({block}) => (
    <TodoContentDecorator block={block} Inner={inner}/>
  )
  Decorated.displayName = 'WithTodoCheckbox'
  todoDecoratorCache.set(inner, Decorated)
  return Decorated
}

const todoContentDecoratorContribution: BlockContentDecoratorContribution =
  () => decorateTodoContent

export const todoPlugin: AppExtension = [
  todoDataExtension,
  blockContentDecoratorsFacet.of(todoContentDecoratorContribution, {source: 'todo'}),
]

export { todoDataExtension } from './dataExtension.ts'
export {
  roamTodoStateProp,
  statusProp,
  TODO_TYPE,
  todoType,
  type RoamTodoState,
  type TodoStatus,
} from './schema.ts'

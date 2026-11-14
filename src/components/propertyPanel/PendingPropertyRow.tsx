import type {Block} from '@/data/block'
import type {AnyPropertySchema} from '@/data/api'
import {Input} from '@/components/ui/input'
import {usePropertyEditingActivation} from './usePropertyEditingActivation'

interface PendingPropertyRowProps {
  owner: Block
  schema: AnyPropertySchema
  autoFocus?: boolean
  draft: string
  committing: boolean
  onDraftChange: (text: string) => void
  onCommit: (text: string) => void
  onCancel: () => void
  onNavigate?: (direction: -1 | 1) => void
}

/** A draft has no block identity: only committing its value may create one. */
export function PendingPropertyRow({owner, schema, autoFocus = false, draft, committing, onDraftChange, onCommit, onCancel, onNavigate}: PendingPropertyRowProps) {
  const activation = usePropertyEditingActivation(owner)
  const submit = () => {
    if (committing) return
    if (draft === '') onCancel()
    else onCommit(draft)
  }

  return <div
    data-pending-property-row="true"
    data-property-name={schema.name}
    className="grid min-w-0 grid-cols-[minmax(6rem,11rem)_minmax(0,1fr)] items-start gap-3 py-0.5"
  >
    <span className="min-w-0 truncate py-1 text-sm text-muted-foreground">{schema.name}</span>
    <Input
      aria-label={`Value for ${schema.name}`}
      autoFocus={autoFocus}
      className="h-7 min-w-0"
      value={draft}
      readOnly={committing}
      onChange={event => onDraftChange(event.target.value)}
      onFocus={activation.onFocus}
      onBlur={() => { activation.onBlur(); submit() }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.stopPropagation()
          event.preventDefault()
          submit()
        } else if (onNavigate && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          event.stopPropagation()
          event.preventDefault()
          onNavigate(event.key === 'ArrowUp' ? -1 : 1)
        }
      }}
    />
  </div>
}

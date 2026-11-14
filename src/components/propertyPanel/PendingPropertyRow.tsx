import {useLayoutEffect, useRef, useState} from 'react'
import type {Block} from '@/data/block'
import type {AnyPropertySchema} from '@/data/api'
import {Input} from '@/components/ui/input'
import {showError} from '@/utils/toast'
import {usePropertyEditingActivation} from './usePropertyEditingActivation'

interface PendingPropertyRowProps {
  owner: Block
  schema: AnyPropertySchema
  autoFocus?: boolean
  onCommit: (content: string) => Promise<void>
  onCancel: () => void
  onHasTextChange?: (hasText: boolean) => void
  onNavigate?: (direction: -1 | 1) => void
}

/** A draft has no block identity: only committing its value may create one. */
export function PendingPropertyRow({owner, schema, autoFocus = false, onCommit, onCancel, onHasTextChange, onNavigate}: PendingPropertyRowProps) {
  const [draft, setDraft] = useState('')
  const [committing, setCommitting] = useState(false)
  const phase = useRef<{state: 'editing' | 'committing' | 'done'}>({state: 'editing'})
  const mounted = useRef(false)
  const activation = usePropertyEditingActivation(owner)
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const cancel = () => {
    if (phase.current.state === 'done') return
    phase.current = {state: 'done'}
    setDraft('')
    onHasTextChange?.(false)
    setCommitting(false)
    onCancel()
  }
  const commit = async () => {
    if (phase.current.state !== 'editing') return
    if (draft === '') return cancel()
    const attempt = {state: 'committing' as const}
    phase.current = attempt
    setCommitting(true)
    try {
      await onCommit(draft)
      if (phase.current === attempt) phase.current = {state: 'done'}
    } catch (error) {
      if (!mounted.current || phase.current !== attempt) return
      phase.current = {state: 'editing'}
      setCommitting(false)
      showError(error instanceof Error ? error.message : 'Could not save property value')
    }
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
      onChange={event => {
        phase.current = {state: 'editing'}
        setDraft(event.target.value)
        onHasTextChange?.(event.target.value !== '')
      }}
      onFocus={activation.onFocus}
      onBlur={() => { activation.onBlur(); void commit() }}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Escape') {
          event.preventDefault()
          cancel()
        } else if (event.key === 'Enter') {
          event.preventDefault()
          void commit()
        } else if (onNavigate && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          event.preventDefault()
          onNavigate(event.key === 'ArrowUp' ? -1 : 1)
        }
      }}
    />
  </div>
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  consumePendingPropertyCreateRequest,
  focusPropertyRowByNameWhenReady,
  subscribePropertyCreateRequests,
} from '@/utils/propertyNavigation.ts'
import {
  ADDABLE_PROPERTY_KINDS,
  type AddablePropertyKind,
  isAddablePropertyKind,
} from './kinds'
import { PropertyKindButton } from './kindUi'
import { InlineEmptyValue } from './InlinePropertyValueEditor'
import { PROPERTY_ROW_GRID_STYLE } from './layout'
import { FieldConfigSheet } from './FieldConfigSheet'

export function AddPropertyForm({
  blockId,
  onAdd,
}: {
  blockId: string
  onAdd: (name: string, kind: AddablePropertyKind) => void
}) {
  const [initialRequest] = useState(() => consumePendingPropertyCreateRequest(blockId))
  const [isOpen, setIsOpen] = useState(Boolean(initialRequest))
  const [propertyName, setPropertyName] = useState(initialRequest?.initialName ?? '')
  const [propertyKind, setPropertyKind] = useState<AddablePropertyKind>('string')
  const [configOpen, setConfigOpen] = useState(false)
  const nameInputRef = useRef<HTMLInputElement | null>(null)

  const focusNameInput = useCallback(() => {
    const focus = () => {
      nameInputRef.current?.focus()
      nameInputRef.current?.setSelectionRange(0, nameInputRef.current.value.length)
    }
    if (typeof requestAnimationFrame === 'undefined') focus()
    else requestAnimationFrame(focus)
  }, [])

  const openForm = useCallback((initialName = '') => {
    setPropertyName(initialName)
    setPropertyKind('string')
    setConfigOpen(false)
    setIsOpen(true)
    focusNameInput()
  }, [focusNameInput])

  useEffect(() => {
    return subscribePropertyCreateRequests(blockId, detail => openForm(detail.initialName))
  }, [blockId, openForm])

  useEffect(() => {
    if (isOpen) focusNameInput()
  }, [focusNameInput, isOpen])

  const handleAdd = () => {
    const name = propertyName.trim()
    if (!name) return
    onAdd(name, propertyKind)
    setPropertyName('')
    setPropertyKind('string')
    setConfigOpen(false)
    setIsOpen(false)
    focusPropertyRowByNameWhenReady(blockId, name)
  }

  if (!isOpen) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-fit gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
        title="Add field"
        onClick={() => openForm()}
      >
        <Plus className="h-3.5 w-3.5" />
        Field
      </Button>
    )
  }

  return (
    <div
      className="grid items-center gap-2 border-b border-border/40 py-0.5 text-sm"
      style={PROPERTY_ROW_GRID_STYLE}
    >
      <PropertyKindButton
        kind={propertyKind}
        schemaUnknown
        label="New field"
        onClick={() => setConfigOpen(true)}
      />
      <Input
        ref={nameInputRef}
        placeholder="Field"
        value={propertyName}
        onChange={(event) => setPropertyName(event.target.value)}
        className="h-7 min-w-0 border-transparent bg-transparent px-0 text-sm shadow-none placeholder:text-muted-foreground/60 focus-visible:border-transparent focus-visible:ring-0"
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault()
            handleAdd()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            setConfigOpen(false)
            setIsOpen(false)
          }
        }}
      />
      <InlineEmptyValue kind={propertyKind} />
      <div />
      <FieldConfigSheet
        field={configOpen ? {
          labelText: propertyName.trim() || 'New field',
          kind: propertyKind,
          kindOptions: ADDABLE_PROPERTY_KINDS,
          schemaUnknown: true,
          decodeFailed: false,
          readOnly: false,
        } : null}
        onKindChange={(next) => {
          if (isAddablePropertyKind(next)) setPropertyKind(next)
        }}
        onClose={() => setConfigOpen(false)}
      />
    </div>
  )
}

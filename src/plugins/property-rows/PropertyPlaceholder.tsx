import {usePropertyEditingActivation} from '@/components/propertyPanel/usePropertyEditingActivation'
import {useEffect, useRef} from 'react'
import type {Block} from '@/data/block'
import type {AnyPropertySchema} from '@/data/api'
import {insertPropertyValue} from '@/data/propertyRowCreation'
import {focusBlock, isEditingProp, peekFocusedBlockLocation} from '@/data/properties'
import {useUIStateBlock} from '@/data/globalState'
import {useHandle} from '@/hooks/block'
import {useBlockContext} from '@/context/block'
import {enterEditModeForBlock} from '@/extensions/blockInteraction'
import {navigatePlaceholder} from '@/utils/outlinePlaceholderNavigation'
import {showError} from '@/utils/toast'

/** A focus target only. The first input belongs to a real block, never to a draft. */
export function PropertyPlaceholder({owner, schema, fieldRowId}: {owner: Block; schema: AnyPropertySchema; fieldRowId?: string}) {
  const ui = useUIStateBlock()
  const editing = usePropertyEditingActivation(owner)
  const context = useBlockContext()
  const scope = typeof context.renderScopeId === 'string' ? context.renderScopeId : undefined
  const element = useRef<HTMLDivElement>(null)
  const creation = useRef<ReturnType<typeof insertPropertyValue> | null>(null)
  const focused = useHandle(ui, {selector: () => {
    const location = peekFocusedBlockLocation(ui)
    return location?.blockId === fieldRowId && location?.renderScopeId === scope && !ui.peekProperty(isEditingProp)
  }})
  useEffect(() => { if (focused) element.current?.focus() }, [focused])
  const input = (text: string) => {
    if (!text) return
    const current = element.current
    const previous = creation.current
    const next = previous ? previous.then(async target => {
      if (target) await owner.repo.tx(async tx => {
        const value = await tx.get(target.valueId)
        if (value && !value.deleted) await tx.update(value.id, {content: value.content + text})
      }, {scope: schema.changeScope})
      return target
    }) : insertPropertyValue(owner, schema, text)
    creation.current = next
    void next.then(async target => {
      if (target && (current === document.activeElement || (!current?.isConnected && document.activeElement === document.body && peekFocusedBlockLocation(ui)?.blockId === (fieldRowId ?? owner.id))) && creation.current === next) {
        await enterEditModeForBlock(owner.repo.block(target.valueId), ui, scope, {start: Number.MAX_SAFE_INTEGER})
      }
      if (creation.current === next) creation.current = null
    }).catch(error => { creation.current = null; showError(error instanceof Error ? error.message : 'Could not enter value') })
  }
  const acceptInput = (target: HTMLDivElement) => {
    const text = target.textContent ?? ''
    target.textContent = ''
    input(text)
  }
  return <div ref={element} contentEditable suppressContentEditableWarning tabIndex={0} role="textbox" aria-label={`Enter ${schema.name}`} data-outline-placeholder-scope={scope}
    data-property-placeholder={fieldRowId ?? schema.name} data-property-editing="true" data-block-interaction="ignore"
    data-placeholder="Enter value…"
    onInput={event => { if (!(event.nativeEvent as InputEvent).isComposing) acceptInput(event.currentTarget) }}
    onCompositionEnd={event => acceptInput(event.currentTarget)}
    className="empty:before:content-[attr(data-placeholder)] empty:before:pointer-events-none min-h-7 rounded-sm px-1 text-muted-foreground/60 outline-none focus:ring-1 focus:ring-ring"
    onBlur={editing.onBlur}
    onFocus={event => { editing.onFocus(event); void focusBlock(ui, fieldRowId ?? owner.id, {edit: false, renderScopeId: scope}) }}
    onPaste={event => { event.preventDefault(); event.stopPropagation(); input(event.clipboardData.getData('text/plain')) }}
    onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation()
        void navigatePlaceholder(event.currentTarget, scope, event.key === 'ArrowDown' ? 1 : -1, ui)
      } else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation() }
    }}/>
}

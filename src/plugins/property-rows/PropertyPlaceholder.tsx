import {isImeKeyEvent} from '@/shortcuts/utils'
import {usePropertyEditingActivation} from '@/components/propertyPanel/usePropertyEditingActivation'
import {useRef, useState} from 'react'
import {Block} from '@/data/block'
import type {AnyPropertySchema} from '@/data/api'
import {insertPropertyValue} from '@/data/propertyRowCreation'
import {focusBlock, exitEditModeForBlock, focusedBlockLocationProp} from '@/data/properties'
import {useUIStateBlock} from '@/data/globalState'
import {useBlockContext} from '@/context/block'
import {enterEditModeForBlock} from '@/extensions/blockInteraction'
import {navigatePlaceholder, placeholderEscapeTarget} from '@/utils/outlinePlaceholderNavigation'
import {showError} from '@/utils/toast'
import {EditorView} from '@codemirror/view'

/** Explicitly activated input stays mounted until the ordinary editor owns DOM focus. */
export function PropertyPlaceholder({owner, schema, fieldRowId, available = true, onActiveChange}: {
  owner: Block; schema: AnyPropertySchema; fieldRowId?: string; available?: boolean; onActiveChange?: (active: boolean) => void
}) {
  const ui = useUIStateBlock()
  const editing = usePropertyEditingActivation(owner)
  const context = useBlockContext()
  const scope = typeof context.renderScopeId === 'string' ? context.renderScopeId : undefined
  const element = useRef<HTMLDivElement>(null)
  const busy = useRef(false)
  const [active, setActive] = useState(false)
  const activate = (value: boolean) => { setActive(value); onActiveChange?.(value) }
  const input = () => {
    const current = element.current!
    const initial = current.textContent ?? ''
    if (busy.current || !initial.trim()) return
    busy.current = true
    void owner.repo.undoGroup(async repo => {
      const target = await insertPropertyValue(new Block(repo, owner.id), schema, initial)
      if (!target) return
      if (document.activeElement === current) {
        const blurred = new Promise<void>(resolve => current.addEventListener('blur', () => resolve(), {once: true}))
        await enterEditModeForBlock(owner.repo.block(target.valueId), ui, scope, {start: Number.MAX_SAFE_INTEGER})
        await blurred
      }
      const extra = (current.textContent ?? '').slice(initial.length)
      if (extra) {
        const view = document.activeElement instanceof HTMLElement ? EditorView.findFromDOM(document.activeElement) : null
        if (view && document.activeElement?.closest('[data-block-id]')?.getAttribute('data-block-id') === target.valueId) {
          view.dispatch({changes: {from: view.state.doc.length, insert: extra}, selection: {anchor: view.state.doc.length + extra.length}})
        }
        await repo.tx(async tx => {
          const value = await tx.get(target.valueId)
          if (!value || value.deleted) throw new Error('The value row was removed. Your input was kept.')
          await tx.update(value.id, {content: value.content + extra})
        }, {scope: schema.changeScope})
      }
      current.textContent = ''
      activate(false)
    }).catch(error => {
      showError(error instanceof Error ? error.message : 'Could not enter value')
    }).finally(() => { busy.current = false })
  }
  if (!available && !active) return null
  return <div ref={element} contentEditable={active} suppressContentEditableWarning tabIndex={-1} data-block-interaction="ignore" role="textbox" aria-label={`Enter ${schema.name}`} data-outline-placeholder-scope={scope}
    data-property-placeholder={fieldRowId ?? schema.name} data-property-editing="true" data-placeholder="Enter value…"
    onInput={event => { if (!(event.nativeEvent as InputEvent).isComposing) input() }}
    onCompositionEnd={input}
    className="empty:before:content-[attr(data-placeholder)] empty:before:pointer-events-none min-h-7 rounded-sm px-1 text-muted-foreground/60 outline-none focus:ring-1 focus:ring-ring"
    onBlur={() => { editing.onBlur(); if (!busy.current) activate(false) }}
    onFocus={event => { activate(true); editing.onFocus(event); void focusBlock(ui, fieldRowId ?? owner.id, {edit: false, renderScopeId: scope}) }}
    onPaste={event => { event.preventDefault(); event.stopPropagation(); event.currentTarget.textContent += event.clipboardData.getData('text/plain'); input() }}
    onKeyDown={event => {
      if (isImeKeyEvent(event.nativeEvent)) return
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation()
        const target = fieldRowId ?? placeholderEscapeTarget(event.currentTarget, scope, owner.id)
        event.currentTarget.blur()
        if (target) void exitEditModeForBlock(ui, target, scope).then(() => focusBlock(ui, target, {renderScopeId: scope}))
        else void ui.set(focusedBlockLocationProp, undefined)
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation()
        void navigatePlaceholder(event.currentTarget, scope, event.key === 'ArrowDown' ? 1 : -1, ui)
      } else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation() }
    }}/>
}

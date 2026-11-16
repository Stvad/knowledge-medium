import {ActionContextTypes} from '@/shortcuts/types'
import {dispatchActionWithDeps} from '@/shortcuts/runAction'
import {usePlaceholderKeys} from './placeholderKeys'
import {isImeKeyEvent, withRecoveredLetterKey} from '@/shortcuts/utils'
import {usePropertyEditingActivation} from '@/components/propertyPanel/usePropertyEditingActivation'
import {useRef, useState, type KeyboardEvent, type FocusEvent, type ClipboardEvent} from 'react'
import {Block} from '@/data/block'
import type {Repo} from '@/data/repo'
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
export function PropertyPlaceholder({owner, schema, onActiveChange}: {
  owner: Block; schema: AnyPropertySchema; onActiveChange?: (active: boolean) => void
}) {
  const ui = useUIStateBlock()
  const editing = usePropertyEditingActivation(owner)
  const context = useBlockContext()
  const scope = typeof context.renderScopeId === 'string' ? context.renderScopeId : undefined
  const element = useRef<HTMLDivElement>(null)
  const busy = useRef(false)
  const failed = useRef(false)
  const {keys, normalMode} = usePlaceholderKeys()
  const [mode, setMode] = useState<'idle' | 'landed' | 'active'>('idle')
  const activate = (next: typeof mode) => {
    keys.forEach(key => key.matcher.reset())
    setMode(next)
    onActiveChange?.(next !== 'idle')
    const target = element.current!
    if (target) {
      target.contentEditable = String(next === 'active')
      target.dataset.placeholderMode = next
    }
    if (next === 'active') window.getSelection()?.setPosition(target, target.childNodes.length)
  }
  const append = async (repo: Repo, valueId: string, extra: string) => {
    const view = document.activeElement instanceof HTMLElement ? EditorView.findFromDOM(document.activeElement) : null
    if (view && document.activeElement?.closest('[data-block-id]')?.getAttribute('data-block-id') === valueId) {
      view.dispatch({changes: {from: view.state.doc.length, insert: extra}, selection: {anchor: view.state.doc.length + extra.length}})
    }
    await repo.tx(async tx => {
      const value = await tx.get(valueId)
      if (!value || value.deleted) throw new Error('The value row was removed. Your input was kept.')
      await tx.update(value.id, {content: value.content + extra})
    }, {scope: schema.changeScope})
  }
  const handoffFirstInput = async (repo: Repo, current: HTMLDivElement, initial: string) => {
    const target = await insertPropertyValue(new Block(repo, owner.id), schema, initial)
    if (!target) return
    if (document.activeElement === current) {
      const blurred = new Promise<void>(resolve => current.addEventListener('blur', () => resolve(), {once: true}))
      await enterEditModeForBlock(owner.repo.block(target.valueId), ui, scope, {start: Number.MAX_SAFE_INTEGER})
      await blurred
    }
    const extra = (current.textContent ?? '').slice(initial.length)
    if (extra) {
      await append(repo, target.valueId, extra)
    }
    current.textContent = ''
    activate('idle')
  }
  const input = () => {
    const current = element.current!
    const initial = current.textContent ?? ''
    if (current.contentEditable !== 'true' || busy.current || failed.current || !initial.trim()) return
    busy.current = true
    void owner.repo.undoGroup(repo => handoffFirstInput(repo, current, initial)).catch(error => {
      failed.current = true
      showError(error instanceof Error ? error.message : 'Could not enter value')
    }).finally(() => { busy.current = false })
  }
  const handleLandedKey = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()
    const matches = keys.filter(key => key.phase === event.type).map(key => ({key, result: key.matcher.next(withRecoveredLetterKey(event.nativeEvent))}))
    const global = matches.find(({key, result}) => key.kind === 'global' && result.completed)
    if (global) {
      if (dispatchActionWithDeps(global.key.id, undefined, event.nativeEvent, ActionContextTypes.GLOBAL)) event.preventDefault()
      return
    }
    if (matches.some(({result}) => result.pending || result.completed)) event.preventDefault()
    for (const {key, result} of matches) if (result.completed) {
      if (key.kind === 'edit') activate('active')
      else if (key.kind === 'move') void navigatePlaceholder(event.currentTarget, scope, key.move, ui, false)
    }
  }
  const handleActiveKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeKeyEvent(event.nativeEvent)) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (normalMode) {
        activate('landed')
        return
      }
      const target = placeholderEscapeTarget(event.currentTarget, scope, owner.id)
      event.currentTarget.blur()
      if (target) void exitEditModeForBlock(ui, target, scope).then(() => focusBlock(ui, target, {renderScopeId: scope}))
      else void ui.set(focusedBlockLocationProp, undefined)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      void navigatePlaceholder(event.currentTarget, scope, event.key === 'ArrowDown' ? 1 : -1, ui)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.currentTarget.contentEditable !== 'true') handleLandedKey(event)
    else handleActiveKey(event)
  }
  const handleKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.currentTarget.contentEditable !== 'true') handleLandedKey(event)
  }
  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.currentTarget.contentEditable !== 'true') return
    event.currentTarget.textContent += event.clipboardData.getData('text/plain')
    input()
  }
  const handleBlur = () => {
    editing.onBlur()
    if (!busy.current) activate('idle')
  }
  const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
    const target = event.currentTarget
    failed.current = false
    activate(target.dataset.placeholderMode === 'landed' ? 'landed' : 'active')
    editing.onFocus(event)
    void focusBlock(ui, owner.id, {edit: false, renderScopeId: scope})
  }
  return <div ref={element} contentEditable={mode === 'active'} data-placeholder-mode={mode} suppressContentEditableWarning tabIndex={-1} data-block-interaction="ignore" role="textbox" aria-label={`Enter ${schema.name}`} data-outline-placeholder-scope={scope}
    data-property-placeholder={schema.name} data-property-editing="true" data-placeholder="Enter value…"
    onInput={event => { if (!(event.nativeEvent as InputEvent).isComposing) input() }}
    onCompositionEnd={input}
    className="empty:before:content-[attr(data-placeholder)] empty:before:pointer-events-none min-h-7 rounded-sm px-1 text-muted-foreground/60 outline-none focus:data-[placeholder-mode=active]:ring-1 focus:data-[placeholder-mode=active]:ring-ring focus:data-[placeholder-mode=landed]:bg-accent/40"
    onBlur={handleBlur}
    onFocus={handleFocus}
    onClick={() => activate('active')}
    onKeyUp={handleKeyUp}
    onPaste={handlePaste}
    onKeyDown={handleKeyDown}/>
}

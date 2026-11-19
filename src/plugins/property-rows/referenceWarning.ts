import type {AnyPropertySchema} from '@/data/api'
import {propertyValueTargetTypes} from './valueSchema'
import type {Block} from '@/data/block'
import {getBlockTypes} from '@/data/properties'
import {isIdCarryingReference, parseExactReferenceBlockContent} from '@/data/referenceBlock'
import {StateEffect, StateField} from '@codemirror/state'
import {Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet} from '@codemirror/view'
import type {CodeMirrorExtensionContribution} from '@/editor/codeMirrorExtensions'

/** Observe the currently named target, including changes to its type and alias. */
export const watchReferenceWarning = (block: Block, schema: AnyPropertySchema, content: string, report: (warning: string | null) => void, resolvedTargetId?: string | null): (() => void) => {
  const types = propertyValueTargetTypes(schema)
  const parsed = parseExactReferenceBlockContent(content)
  const workspaceId = block.peek()?.workspaceId
  if (!types.length || !parsed || parsed.fieldForm || !workspaceId) {
    report(null)
    return () => {}
  }
  let active = true
  let targetUnsubscribe: (() => void) | undefined
  let generation = 0
  const labels = types.map(id => block.repo.types.get(id)?.label || id).join(', ')
  const observeTarget = (id: string | undefined) => {
    const current = ++generation
    targetUnsubscribe?.()
    targetUnsubscribe = undefined
    report(null)
    if (!id) return
    const target = block.repo.block(id)
    const update = () => {
      const data = target.peek()
      const actual = data && getBlockTypes(data)
      const actualLabels = actual?.map(id => block.repo.types.get(id)?.label || id).join(', ')
      report(data && !data.deleted && data.workspaceId === workspaceId && actual && !types.some(type => actual.includes(type))
        ? `Expected ${labels}; ${actualLabels ? `has ${actualLabels}` : 'has no type'}` : null)
    }
    targetUnsubscribe = target.subscribe(update)
    void target.load().then(() => { if (active && current === generation) update() }).catch(console.error)
  }
  if (resolvedTargetId !== undefined || isIdCarryingReference(parsed)) {
    observeTarget(resolvedTargetId !== undefined ? resolvedTargetId ?? undefined : isIdCarryingReference(parsed) ? parsed.id : undefined)
    return () => { active = false; targetUnsubscribe?.() }
  }
  const alias = block.repo.query.aliasLookup({workspaceId, alias: parsed.alias})
  const updateAlias = () => observeTarget(alias.peek()?.id)
  const unsubscribe = alias.subscribe(updateAlias)
  void alias.load().then(() => { if (active) updateAlias() }).catch(console.error)
  return () => { active = false; unsubscribe(); targetUnsubscribe?.() }
}

class WarningWidget extends WidgetType {
  constructor(readonly message: string) { super() }
  eq(other: WarningWidget) { return this.message === other.message }
  toDOM() {
    const span = document.createElement('span')
    span.textContent = '⚠'
    span.title = this.message
    span.setAttribute('aria-label', this.message)
    span.setAttribute('data-reference-type-warning', 'true')
    return span
  }
}
const setWarning = StateEffect.define<string | null>()
const warningField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes)
    if (tr.docChanged) value = Decoration.none
    for (const effect of tr.effects) if (effect.is(setWarning)) {
      value = effect.value ? Decoration.set([Decoration.widget({widget: new WarningWidget(effect.value), side: -1}).range(0)]) : Decoration.none
    }
    return value
  },
  provide: field => EditorView.decorations.from(field),
})

export const propertyReferenceWarning: CodeMirrorExtensionContribution = editor => {
  const {block, propertyValueSchema} = editor
  if (!block || !propertyValueSchema || !propertyValueTargetTypes(propertyValueSchema).length) return []
  return [warningField, ViewPlugin.fromClass(class {
    stop: (() => void) | undefined
    generation = 0
    constructor(readonly view: EditorView) { this.refresh() }
    refresh() {
      this.stop?.()
      const generation = ++this.generation
      const content = this.view.state.doc.toString()
      this.stop = watchReferenceWarning(block, propertyValueSchema, content, warning => {
        // Defer dispatch until after the current view update has finished.
        queueMicrotask(() => {
          if (this.stop && this.generation === generation && this.view.state.doc.toString() === content) this.view.dispatch({effects: setWarning.of(warning)})
        })
      })
    }
    update(update: {docChanged: boolean}) { if (update.docChanged) this.refresh() }
    destroy() { this.stop?.(); this.stop = undefined }
  })]
}

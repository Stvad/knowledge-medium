import type {AnyPropertySchema, BlockData} from '@/data/api'
import {propertyValueTargetTypes} from './valueSchema'
import type {Block} from '@/data/block'
import {readTypeIds} from '@/utils/linkTargetAutocomplete'
import {isIdCarryingReference, parseExactReferenceBlockContent} from '@/data/referenceBlock'
import {StateEffect, StateField} from '@codemirror/state'
import {Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet} from '@codemirror/view'
import type {CodeMirrorExtensionContribution} from '@/editor/codeMirrorExtensions'

export const referenceWarningMessage = (
  source: Block,
  schema: AnyPropertySchema,
  target: BlockData | null | undefined,
): string | null => {
  if (!target || target.deleted || target.workspaceId !== source.peek()?.workspaceId) return null
  const expected = propertyValueTargetTypes(schema)
  const actual = readTypeIds(target)
  if (expected.some(type => actual.includes(type))) return null
  const labels = (ids: readonly string[]) => ids.map(id => source.repo.types.get(id)?.label || id).join(', ')
  return `${schema.name} expects ${labels(expected)}. ${actual.length ? `This block has type ${labels(actual)}.` : 'This block has no type.'}`
}

/** Resolve the live buffer independently of the debounced block write. */
export const watchReferenceWarning = (
  block: Block, schema: AnyPropertySchema, content: string, report: (warning: string | null) => void,
): (() => void) => {
  const parsed = parseExactReferenceBlockContent(content)
  const workspaceId = block.peek()?.workspaceId
  if (!parsed || parsed.fieldForm || !workspaceId) return () => {}

  // Alias lookup hydrates its winner, so it also reacts to changes to that block’s types.
  const target = isIdCarryingReference(parsed)
    ? block.repo.block(parsed.id)
    : block.repo.query.aliasLookup({workspaceId, alias: parsed.alias})
  const update = () => report(referenceWarningMessage(block, schema, target.peek()))
  const unsubscribe = target.subscribe(update)
  let active = true
  if (target.peek() === undefined) {
    void target.load().then(() => { if (active) update() }).catch(console.error)
  } else {
    update()
  }
  return () => { active = false; unsubscribe() }
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
          if (this.stop && this.generation === generation) {
            this.view.dispatch({effects: setWarning.of(warning)})
          }
        })
      })
    }
    update(update: {docChanged: boolean}) { if (update.docChanged) this.refresh() }
    destroy() { this.stop?.(); this.stop = undefined }
  })]
}

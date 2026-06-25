/**
 * Renders remote peers' carets/selections inside a block's CodeMirror
 * editor. Contributed to `codeMirrorExtensionsFacet`, so `BlockEditor` picks
 * it up for every editing block with zero coupling to the editor itself.
 *
 * Data flow: a `ViewPlugin` subscribes to the presence store and, whenever
 * peers change, dispatches a `StateEffect` carrying this block's remote
 * carets into a `StateField` that provides the decorations. Presence
 * notifications originate from network events (never from inside a CM
 * update), so dispatching from the subscription callback is safe; the very
 * first paint is deferred a frame to avoid dispatching during view
 * construction.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view'
import { type Range, StateEffect, StateField } from '@codemirror/state'
import type { CodeMirrorExtensionContribution } from '@/editor/codeMirrorExtensions.js'
import { presenceClient } from './presenceClient.js'
import type { RemoteCaret } from './types.js'

const setRemoteCarets = StateEffect.define<readonly RemoteCaret[]>()

/** `hsl(h s% l%)` → translucent variant for the selection-range highlight. */
const translucent = (color: string): string => color.replace(/\)\s*$/, ' / 0.25)')

class CaretWidget extends WidgetType {
  constructor(readonly color: string, readonly name: string) {
    super()
  }

  eq(other: CaretWidget): boolean {
    return other.color === this.color && other.name === this.name
  }

  toDOM(): HTMLElement {
    const caret = document.createElement('span')
    caret.style.cssText =
      `position:relative;display:inline-block;height:1.2em;margin-left:-1px;` +
      `border-left:2px solid ${this.color};vertical-align:text-bottom;`
    caret.setAttribute('aria-hidden', 'true')

    const label = document.createElement('span')
    label.textContent = this.name
    label.style.cssText =
      `position:absolute;left:-1px;top:-1.1em;padding:0 4px;border-radius:4px 4px 4px 0;` +
      `background:${this.color};color:#fff;font-size:10px;line-height:1.3;` +
      `white-space:nowrap;font-weight:500;pointer-events:none;`
    caret.appendChild(label)
    return caret
  }

  ignoreEvent(): boolean {
    return true
  }
}

const buildDecorations = (carets: readonly RemoteCaret[], docLength: number): DecorationSet => {
  const ranges: Range<Decoration>[] = []
  for (const caret of carets) {
    const start = Math.max(0, Math.min(caret.start, docLength))
    const end = Math.max(0, Math.min(caret.end, docLength))
    const from = Math.min(start, end)
    const to = Math.max(start, end)
    if (to > from) {
      ranges.push(
        Decoration.mark({
          attributes: { style: `background:${translucent(caret.color)}` },
        }).range(from, to),
      )
    }
    ranges.push(
      Decoration.widget({ widget: new CaretWidget(caret.color, caret.name), side: 1 }).range(start),
    )
  }
  return Decoration.set(ranges, true)
}

const remoteCaretsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    decorations = decorations.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setRemoteCarets)) {
        decorations = buildDecorations(effect.value, tr.state.doc.length)
      }
    }
    return decorations
  },
  provide: field => EditorView.decorations.from(field),
})

const remoteCaretPlugin = (blockId: string) =>
  ViewPlugin.define(view => {
    let destroyed = false
    let lastKey = ''
    const push = () => {
      if (destroyed) return
      const carets = presenceClient.caretsForBlock(blockId)
      const key = carets.map(c => `${c.clientId}:${c.start}:${c.end}:${c.color}`).join('|')
      if (key === lastKey) return
      lastKey = key
      view.dispatch({ effects: setRemoteCarets.of(carets) })
    }
    const unsubscribe = presenceClient.subscribePresence(push)
    const raf = requestAnimationFrame(push)
    return {
      destroy() {
        destroyed = true
        unsubscribe()
        cancelAnimationFrame(raf)
      },
    }
  })

export const remoteCaretsCodeMirrorExtensions: CodeMirrorExtensionContribution = ({ block }) => [
  remoteCaretsField,
  remoteCaretPlugin(block.id),
]

import type {CompletionContext} from '@codemirror/autocomplete'
import {completionQueryEnd} from '@/utils/codemirrorCompletion'
import {referenceTargetTypes} from './referenceTargetTypes'

/** Constrain only a reference occupying the whole value; consume a suffix only
 * when a matching delimiter proves where that reference ends. */
export const constrainedReferenceRange = (
  context: CompletionContext,
  start: number,
  close: ']]' | '))',
): {types: readonly string[]; end: number} | undefined => {
  const types = context.state.facet(referenceTargetTypes)
  if (!types.length) return undefined
  const text = context.state.doc.toString()
  const pos = completionQueryEnd(context)
  if (text.slice(0, start - 2).trim()) return undefined
  const closing = text.indexOf(close, pos)
  const end = closing < 0 ? pos : closing
  if (closing < 0 ? text.slice(pos).trim() : text.slice(closing + 2).trim()) return undefined
  const interior = text.slice(start, end)
  if (close === ']]' ? /\[\[|\]|\n/.test(interior) : /[()\n]/.test(interior)) return undefined
  return {types, end}
}

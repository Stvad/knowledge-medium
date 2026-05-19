import { completionKeymap } from '@codemirror/autocomplete'
import type { KeyBinding } from '@codemirror/view'

const handlesEscape = (binding: KeyBinding) =>
  binding.key === 'Escape' ||
  binding.mac === 'Escape' ||
  binding.linux === 'Escape' ||
  binding.win === 'Escape'

export const completionKeymapWithEscapeFallthrough: readonly KeyBinding[] =
  completionKeymap
    .filter(binding => !handlesEscape(binding))
    .map(binding => ({...binding, stopPropagation: true}))

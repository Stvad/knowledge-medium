import {createElement} from 'react'
import {definePropertyEditorOverride, type PropertyEditorProps} from '@/data/api'
import {keybindingOverridesProp, type StoredKeybindingOverrides} from './config.ts'
import {KeybindingsEditor} from './KeybindingsEditor.tsx'

// Wrap the editor in a thin function so the import binding is read at
// render time (matches the same TDZ-avoidance pattern as the
// extensions-settings editor).
const KeybindingsEditorEntry = (props: PropertyEditorProps<StoredKeybindingOverrides>) =>
  createElement(KeybindingsEditor, props)

export const keybindingsOverridesUi = definePropertyEditorOverride(keybindingOverridesProp, {
  label: 'Keyboard shortcuts',
  Editor: KeybindingsEditorEntry,
})

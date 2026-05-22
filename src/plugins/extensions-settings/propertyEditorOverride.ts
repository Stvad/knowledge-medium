import {createElement} from 'react'
import {definePropertyEditorOverride, type PropertyEditorProps} from '@/data/api'
import type {Overrides} from '@/extensions/togglable.js'
import {extensionsOverridesProp} from './config.ts'
import {ExtensionsOverridesEditor} from './ExtensionsOverridesEditor.tsx'

// Wrap the editor in a thin function so the `ExtensionsOverridesEditor`
// import binding is read at render time rather than module-eval time. The
// registration is part of a cycle (this file ← dataExtension ← barrel ←
// staticAppExtensions ← useToggleTree ← ExtensionsOverridesEditor), and
// reading the binding directly hits a TDZ when Vite re-evaluates the
// module mid-HMR.
const ExtensionsOverridesEditorEntry = (props: PropertyEditorProps<Overrides>) =>
  createElement(ExtensionsOverridesEditor, props)

export const extensionsOverridesUi = definePropertyEditorOverride<Overrides>({
  name: extensionsOverridesProp.name,
  label: 'Extensions',
  Editor: ExtensionsOverridesEditorEntry,
})

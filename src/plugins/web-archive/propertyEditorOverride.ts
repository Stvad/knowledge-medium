import { createElement } from 'react'
import { definePropertyEditorOverride, type PropertyEditorProps } from '@/data/api'
import { archiveEnabledProp } from './prefs.ts'
import { WebArchiveConsentEditor } from './ui/WebArchiveConsentEditor.tsx'

// Indirection so the component binding is read at render time, not
// module-eval time — the registration sits in the plugin barrel's import
// cycle and a direct reference hits a TDZ when Vite re-evaluates mid-HMR
// (same reason as `extensions-settings`).
const WebArchiveConsentEditorEntry = (props: PropertyEditorProps<boolean>) =>
  createElement(WebArchiveConsentEditor, props)

export const webArchiveConsentUi = definePropertyEditorOverride(archiveEnabledProp, {
  label: 'Archive links I save',
  Editor: WebArchiveConsentEditorEntry,
})

import {definePropertyEditorOverride} from '@/data/api'
import type {Overrides} from '@/extensions/togglable.ts'
import {extensionsOverridesProp} from './config.ts'
import {ExtensionsOverridesEditor} from './ExtensionsOverridesEditor.tsx'

export const extensionsOverridesUi = definePropertyEditorOverride<Overrides>({
  name: extensionsOverridesProp.name,
  label: 'Extensions',
  Editor: ExtensionsOverridesEditor,
})

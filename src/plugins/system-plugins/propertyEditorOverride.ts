import {definePropertyEditorOverride} from '@/data/api'
import type {Overrides} from '@/extensions/togglable.ts'
import {systemPluginOverridesProp} from './config.ts'
import {SystemPluginsOverridesEditor} from './SystemPluginsOverridesEditor.tsx'

export const systemPluginOverridesUi = definePropertyEditorOverride<Overrides>({
  name: systemPluginOverridesProp.name,
  label: 'System plugins',
  Editor: SystemPluginsOverridesEditor,
})

import { definePropertyEditorOverride } from '@/data/api'
import { blockTagsConfigProp } from './config.ts'
import { BlockTagsConfigEditor } from './BlockTagsConfigEditor.tsx'

export const blockTagsConfigUi = definePropertyEditorOverride<string[]>({
  name: blockTagsConfigProp.name,
  label: 'Block tags',
  Editor: BlockTagsConfigEditor,
})

import {
  definePropertyEditorOverride,
  type PropertyEditorOverride,
  type PropertySchema,
} from '@/data/api'
import { RefListPropertyEditor, RefPropertyEditor } from './RefPropertyEditor'

interface RefPropertyEditorOverrideOptions {
  label?: string
  category?: string
}

export const defineRefPropertyEditorOverride = (
  schema: PropertySchema<string>,
  options: RefPropertyEditorOverrideOptions = {},
): PropertyEditorOverride<string> =>
  definePropertyEditorOverride<string>({
    name: schema.name,
    ...options,
    Editor: RefPropertyEditor,
  })

export const defineRefListPropertyEditorOverride = (
  schema: PropertySchema<readonly string[]>,
  options: RefPropertyEditorOverrideOptions = {},
): PropertyEditorOverride<readonly string[]> =>
  definePropertyEditorOverride<readonly string[]>({
    name: schema.name,
    ...options,
    Editor: RefListPropertyEditor,
  })

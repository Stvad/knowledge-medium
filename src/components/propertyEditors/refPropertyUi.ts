import {
  definePropertyUi,
  type PropertySchema,
  type PropertyUiContribution,
} from '@/data/api'
import { RefListPropertyEditor, RefPropertyEditor } from './RefPropertyEditor'

interface RefPropertyUiOptions {
  label?: string
  category?: string
}

export const defineRefPropertyUi = (
  schema: PropertySchema<string>,
  options: RefPropertyUiOptions = {},
): PropertyUiContribution<string> =>
  definePropertyUi<string>({
    name: schema.name,
    ...options,
    Editor: RefPropertyEditor,
  })

export const defineRefListPropertyUi = (
  schema: PropertySchema<readonly string[]>,
  options: RefPropertyUiOptions = {},
): PropertyUiContribution<readonly string[]> =>
  definePropertyUi<readonly string[]>({
    name: schema.name,
    ...options,
    Editor: RefListPropertyEditor,
  })

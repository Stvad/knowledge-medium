/** Per-name property editor overrides exposed by the geo plugin. Only
 *  the `location` property needs one — the codec-based default editor
 *  for refs (`RefPropertyEditor`) doesn't know how to call out to
 *  Google Places. */

import { definePropertyEditorOverride } from '@/data/api'
import { locationProp } from './properties'
import { LocationPropertyEditor } from './LocationPropertyEditor'

export const locationPropertyEditorOverride = definePropertyEditorOverride(locationProp, {
  label: 'Location',
  Editor: LocationPropertyEditor,
})

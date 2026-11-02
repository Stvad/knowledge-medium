/** `char:profile` editor: a select over the profiles registered right now, so
 *  one an extension adds shows up without a schema change. */

import { definePropertyEditorOverride, type PropertyEditorProps } from '@/data/api'
import { OptionSelect } from '@/components/propertyEditors/SelectPropertyEditor'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { charProfileProp, RAW_CHARACTER_COUNT_PROFILE_ID } from './properties'
import { characterCountProfilesFacet, profileLabel } from './profiles'

export const ProfilePropertyEditor = ({
  value,
  onChange,
  block,
  schema,
}: PropertyEditorProps<string | undefined>) => {
  const profiles = useAppRuntime().read(characterCountProfilesFacet)
  const options = [...profiles.values()].map(profile => ({
    value: profile.id,
    label: profileLabel(profile),
  }))
  return (
    <OptionSelect
      value={value ?? RAW_CHARACTER_COUNT_PROFILE_ID}
      onChange={onChange}
      block={block}
      name={schema?.name}
      options={options}
    />
  )
}

export const charProfileEditorOverride = definePropertyEditorOverride(charProfileProp, {
  label: 'Count by',
  Editor: ProfilePropertyEditor,
})

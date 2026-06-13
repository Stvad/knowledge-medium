import { useState } from 'react'
import { Block } from '../../data/block'
import { useInFocus, usePluginPrefsProperty, useUserPage } from '@/data/globalState'
import { useUpdateMetadata } from '@/hooks/block.js'
import { previousLoadTimeProp, updateIndicatorPrefsType } from './loadTimes.ts'

export const UpdateIndicator = ({block}: { block: Block }) => {
  const inFocus = useInFocus(block.id)
  const [previousLoadTime] = usePluginPrefsProperty(updateIndicatorPrefsType, previousLoadTimeProp)
  const updateInfo = useUpdateMetadata(block)
  const updatedByName = useUserPage(updateInfo?.updatedBy ?? '').name
  // `seen` is a sticky ratchet — once focus has touched this block
  // we don't show the indicator again. The "set state during render"
  // idiom (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
  // is the React-blessed alternative to a setState-in-effect for
  // this derived-from-prop pattern.
  const [seen, setSeen] = useState(false)
  if (inFocus && !seen) setSeen(true)

  if (!updateInfo) return null

  // A pristine deterministic-id mint (row-version `updated_at === 0`, never
  // user-edited) is not "another user's edit" — don't raise the indicator for
  // it, even when it arrived via sync authored by another user id. Freshness
  // and the timestamp are the user-facing `userUpdatedAt`, not the row-version.
  const updatedByOtherUser = updateInfo.updatedBy !== block.repo.user.id
    && updateInfo.updatedAt !== 0
    && updateInfo.userUpdatedAt > (previousLoadTime ?? 0)
  const shouldShowUpdateIndicator = updatedByOtherUser && !seen

  if (!shouldShowUpdateIndicator) return null

  return (
    <div
      className="absolute right-1 top-1 h-2 w-2 rounded-full bg-blue-400"
      title={`Updated by ${updatedByName} on ${new Date(updateInfo.userUpdatedAt).toLocaleString()}`}
    />
  )
}

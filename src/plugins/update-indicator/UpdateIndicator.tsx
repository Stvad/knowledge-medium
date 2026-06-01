import { useState } from 'react'
import { Block } from '../../data/block'
import { useInFocus, usePluginPrefsProperty, useUserName } from '@/data/globalState'
import { useUpdateMetadata } from '@/hooks/block.js'
import { previousLoadTimeProp, updateIndicatorPrefsType } from './loadTimes.ts'

export const UpdateIndicator = ({block}: { block: Block }) => {
  const inFocus = useInFocus(block.id)
  const [previousLoadTime] = usePluginPrefsProperty(updateIndicatorPrefsType, previousLoadTimeProp)
  const updateInfo = useUpdateMetadata(block)
  const updatedByName = useUserName(updateInfo?.updatedBy ?? '')
  // `seen` is a sticky ratchet — once focus has touched this block
  // we don't show the indicator again. The "set state during render"
  // idiom (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
  // is the React-blessed alternative to a setState-in-effect for
  // this derived-from-prop pattern.
  const [seen, setSeen] = useState(false)
  if (inFocus && !seen) setSeen(true)

  if (!updateInfo) return null

  const updatedByOtherUser = updateInfo.updatedBy !== block.repo.user.id
    && updateInfo.updatedAt > (previousLoadTime ?? 0)
  const shouldShowUpdateIndicator = updatedByOtherUser && !seen

  if (!shouldShowUpdateIndicator) return null

  return (
    <div
      className="absolute right-1 top-1 h-2 w-2 rounded-full bg-blue-400"
      title={`Updated by ${updatedByName} on ${new Date(updateInfo.updatedAt).toLocaleString()}`}
    />
  )
}

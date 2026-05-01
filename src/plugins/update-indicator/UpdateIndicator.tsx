import { useEffect, useState } from 'react'
import { Block } from '@/data/internals/block'
import { useInFocus, useUserProperty } from '@/data/globalState'
import { previousLoadTimeProp } from '@/data/properties.ts'
import { useData } from '@/hooks/block.ts'

export const UpdateIndicator = ({block}: { block: Block }) => {
  const inFocus = useInFocus(block.id)
  const [previousLoadTime] = useUserProperty(previousLoadTimeProp)
  const blockData = useData(block)
  const [seen, setSeen] = useState(false)

  useEffect(() => {
    if (inFocus) setSeen(true)
  }, [inFocus])

  if (!blockData) return null

  const updatedByOtherUser = blockData.updatedBy !== block.repo.user.id
    && blockData.updatedAt > (previousLoadTime ?? 0)
  const shouldShowUpdateIndicator = updatedByOtherUser && !seen

  if (!shouldShowUpdateIndicator) return null

  return (
    <div
      className="absolute right-1 top-1 h-2 w-2 rounded-full bg-blue-400"
      title={`Updated by ${blockData.updatedBy} on ${new Date(blockData.updatedAt).toLocaleString()}`}
    />
  )
}

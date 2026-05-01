import { useEffect, useState } from 'react'
import { Block } from '@/data/internals/block'
import { useInFocus, useUserProperty } from '@/data/globalState'
import { previousLoadTimeProp } from '@/data/properties.ts'
import { useData } from '@/hooks/block.ts'

/**
 * Small dot in the top-right corner of a block flagging that another user
 * touched the block since this user's previous session. Clears on focus.
 *
 * Mounted via `blockContentDecoratorsFacet` from `index.ts`, which wraps
 * the block's content in a positioned ancestor so this component's
 * `absolute right-1 top-1` lands on the content area regardless of layout.
 */
export const UpdateIndicator = ({block}: { block: Block }) => {
  const [seen, setSeen] = useState(false)
  const inFocus = useInFocus(block.id)
  const [previousLoadTime] = useUserProperty(previousLoadTimeProp)
  const blockData = useData(block)

  useEffect(() => {
    if (inFocus && !seen) {
      setSeen(true)
    }
  }, [inFocus, seen])

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

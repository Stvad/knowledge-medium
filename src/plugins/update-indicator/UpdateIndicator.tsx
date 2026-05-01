import { useEffect, useReducer } from 'react'
import { Block } from '@/data/internals/block'
import { useInFocus, useUserProperty } from '@/data/globalState'
import { previousLoadTimeProp } from '@/data/properties.ts'
import { useData } from '@/hooks/block.ts'

/**
 * Per-tab session memory of "I've focused this block at least once, so the
 * 'updated by other user' badge can stop pestering me."
 *
 * Lives at module scope rather than in component state on purpose: this
 * component is mounted via a content decorator, and the decorator's
 * wrapped renderer is rebuilt whenever blockInteractionContext changes
 * (focus / edit-mode / selection / top-level toggles). A re-rebuild
 * unmounts the wrapper and any local React state goes with it — which
 * would mean the dot reappears every time the user clicks away.
 *
 * Page reload resets the Set, which is fine: reload also bumps
 * `previousLoadTime`, so only updates the page hasn't seen yet count as
 * "new" in the first place.
 */
const seenBlocks = new Set<string>()

export const UpdateIndicator = ({block}: { block: Block }) => {
  const inFocus = useInFocus(block.id)
  const [previousLoadTime] = useUserProperty(previousLoadTimeProp)
  const blockData = useData(block)
  const [, forceRender] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    if (inFocus && !seenBlocks.has(block.id)) {
      seenBlocks.add(block.id)
      forceRender()
    }
  }, [inFocus, block.id])

  if (!blockData) return null

  const updatedByOtherUser = blockData.updatedBy !== block.repo.user.id
    && blockData.updatedAt > (previousLoadTime ?? 0)
  const shouldShowUpdateIndicator = updatedByOtherUser && !seenBlocks.has(block.id)

  if (!shouldShowUpdateIndicator) return null

  return (
    <div
      className="absolute right-1 top-1 h-2 w-2 rounded-full bg-blue-400"
      title={`Updated by ${blockData.updatedBy} on ${new Date(blockData.updatedAt).toLocaleString()}`}
    />
  )
}

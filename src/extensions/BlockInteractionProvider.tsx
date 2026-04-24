import type { PropsWithChildren } from 'react'
import type { BlockInteractionContext } from '@/extensions/blockInteraction.ts'
import { ReactBlockInteractionContext } from '@/extensions/blockInteractionContext.tsx'

export function BlockInteractionProvider(
  {context, children}: PropsWithChildren<{ context: BlockInteractionContext }>,
) {
  return (
    <ReactBlockInteractionContext.Provider value={context}>
      {children}
    </ReactBlockInteractionContext.Provider>
  )
}

import { useMemo } from 'react'
import type { BlockData } from '@/data/api'
import { useRepo } from '@/context/repo.js'
import { useBlockQuery, useHandle } from '@/hooks/block.js'
import { UNRESOLVED_TAG_ID, buildDueCardsQuery } from './dueQuery.ts'

/** Reactive list of SRS cards due today or earlier for a deck.
 *
 *  A non-empty `tagName` is resolved to its page block id via
 *  `core.aliasLookup`; when the page doesn't exist the deck targets
 *  `UNRESOLVED_TAG_ID` so it reports zero rather than every due card.
 *  An empty `tagName` is the "all due" deck (no tag filter). */
export const useDueCards = (workspaceId: string, tagName: string): BlockData[] => {
  const repo = useRepo()
  const alias = tagName.trim()
  const wantsTag = alias.length > 0

  // aliasLookup short-circuits to null on an empty alias, so the
  // all-due deck simply gets a null tag id.
  const resolvedId = useHandle(
    repo.query.aliasLookup({workspaceId, alias: wantsTag ? alias : ''}),
    {selector: data => (data ? data.id : null)},
  ) as string | null
  const tagBlockId = wantsTag ? (resolvedId ?? UNRESOLVED_TAG_ID) : null

  const query = useMemo(
    () => buildDueCardsQuery({workspaceId, tagBlockId}),
    [workspaceId, tagBlockId],
  )
  return useBlockQuery(query)
}

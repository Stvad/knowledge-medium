/**
 * "Another page already uses this name" — and the one-click merge that fixes it.
 *
 * A page can end up without its own name: get-or-create yields a contested
 * alias rather than fighting for it, because claiming one trips alias
 * uniqueness and rolls back the transaction the page is created in (issue
 * #378). The page is then reachable but `[[Name]]` resolves elsewhere, which
 * is a silently wrong target — exactly the failure this codebase would rather
 * make loud.
 *
 * A banner rather than a toast because the state is PERSISTENT: it lasts until
 * someone merges, so a notification that scrolls away would be the wrong
 * shape. Shown only on the focal render, so a page mentioned in a sidebar or
 * breadcrumb stays quiet.
 *
 * Merge direction is canonical-wins — this page is `into`, the other is
 * `from` — so identity stays at the deterministic id and the name comes back
 * here along with the other page's children, properties and inbound
 * references.
 */
import { useState } from 'react'
import { Merge } from 'lucide-react'
import { Button } from '@/components/ui/button.js'
import { useRepo } from '@/context/repo.js'
import { useHandle } from '@/hooks/block.js'
import { isFocalRender } from '@/hooks/useIsFocalRender.js'
import { PAGE_TYPE } from '@/data/blockTypes.js'
import { MergeIntoDescendantError } from '@/data/api'
import { showError } from '@/utils/toast.js'
import { navigateFromGlobalCommand } from '@/utils/navigation.js'
import { truncate } from '@/utils/string.js'
import type { BlockHeaderContribution } from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types'
import { ALIAS_COLLISION_MERGE_MUTATOR } from './collisionMerge.ts'

export const DuplicateNameBanner: BlockRenderer = ({block}) => {
  const repo = useRepo()
  const [merging, setMerging] = useState(false)
  const data = block.peek()
  const name = (data?.content ?? '').trim()
  const workspaceId = data?.workspaceId ?? ''
  // Unconditional so the hook order is stable; an empty alias simply misses.
  // The selector narrows the subscription to the one thing that matters — a
  // re-render per edit to the other page would be pure noise.
  const duplicateId = useHandle(repo.query.aliasLookup({workspaceId, alias: name}), {
    selector: owner => (owner && owner.id !== block.id ? owner.id : null),
  })
  if (name === '' || workspaceId === '' || !duplicateId) return null

  const merge = async (): Promise<void> => {
    setMerging(true)
    try {
      await repo.run(ALIAS_COLLISION_MERGE_MUTATOR, {
        intoId: block.id,
        fromId: duplicateId,
        collisionAlias: name,
      })
    } catch (error) {
      // The one refusal worth explaining: merging a block into its own
      // descendant can never succeed, and the raw error says nothing useful.
      showError(error instanceof MergeIntoDescendantError
        ? `“${truncate(name, 40)}” is inside this page — move it out before merging.`
        : `Couldn’t merge “${truncate(name, 40)}”.`)
    } finally {
      setMerging(false)
    }
  }

  return (
    // `pr-14` keeps the copy clear of the panel's back/forward controls, which
    // are positioned over this row's right edge and overlap the text at narrow
    // widths.
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 py-2 pl-3 pr-14 text-sm">
      <span className="text-muted-foreground">
        Another page is named “{truncate(name, 40)}”, so links to it go there.
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7"
        onClick={() => { void navigateFromGlobalCommand(repo, {blockId: duplicateId, workspaceId}) }}
      >
        Open it
      </Button>
      <Button size="sm" className="h-7" disabled={merging} onClick={() => { void merge() }}>
        <Merge className="mr-1 h-3.5 w-3.5"/>
        Merge into this page
      </Button>
    </div>
  )
}

/** Pages only, and only when it is the page being read. */
export const duplicateNameBannerHeader: BlockHeaderContribution = ctx =>
  isFocalRender(ctx) && ctx.types.includes(PAGE_TYPE) ? DuplicateNameBanner : null

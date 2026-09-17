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
 * Owning the name is not the same as owning it ALONE, which is why this reads
 * the full claimant list rather than "who does this name resolve to". The
 * uniqueness trigger skips sync-apply, so two devices that create the same
 * page offline both keep their claim; a single-row lookup then reports the
 * page's own id and the banner stays silent while `[[Name]]` lands on
 * whichever of them happens to be older.
 *
 * A banner rather than a toast because the state is PERSISTENT: it lasts until
 * someone merges, so a notification that scrolls away would be the wrong
 * shape. Shown only on the focal render, so a page mentioned in a sidebar or
 * breadcrumb stays quiet.
 *
 * The merge itself — refusal, mutator call, panel retargeting, error copy —
 * lives in `mergeAliasCollision` (`./mergeCollisionAction.ts`); this page is
 * always the merge's `into`, the rivals its `from`.
 */
import { useState } from 'react'
import { Merge } from 'lucide-react'
import { Button } from '@/components/ui/button.js'
import { useRepo } from '@/context/repo.js'
import { useHandle } from '@/hooks/block.js'
import { isFocalRender } from '@/hooks/useIsFocalRender.js'
import { PAGE_TYPE } from '@/data/blockTypes.js'
import { navigateFromGlobalCommand } from '@/utils/navigation.js'
import { useContent, useWorkspaceId } from '@/hooks/block.js'
import { truncate } from '@/utils/string.js'
import type { BlockHeaderContribution } from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types'
import { mergeAliasCollision } from './mergeCollisionAction.ts'

/** Every wording here has to be TRUE of the state that produced it. When this
 *  page still claims the name, "links to it go there" is false — links land
 *  here, and the problem is that nothing guarantees they keep doing so. */
const duplicateNameMessage = (
  name: string, rivals: number, sharesTheName: boolean,
): string => {
  const subject = rivals === 1 ? 'Another page is' : `${rivals} other pages are`
  if (sharesTheName) return `${subject} also named “${name}”, so links to it are ambiguous.`
  return rivals === 1
    ? `${subject} named “${name}”, so links to it go there.`
    : `${subject} named “${name}”, so links to it go to one of them.`
}

export const DuplicateNameBanner: BlockRenderer = ({block}) => {
  const repo = useRepo()
  const [merging, setMerging] = useState(false)
  // Reactive, not `peek()`: the name is what the whole banner keys on, and a
  // rename while it is on screen would otherwise leave a stale offer wired to
  // the old name — clicking it would fold a page in over a name this page no
  // longer has. Narrow hooks rather than the whole row, per
  // `block/no-broad-block-subscriptions`.
  // EXACT content, not trimmed: aliases are exact, and the parser trims only
  // the wikilink label — so " Foo " and "Foo" are different names. Trimming
  // here would look up an alias this page does not claim and offer to absorb
  // whichever unrelated page owns it.
  const name = useContent(block)
  const workspaceId = useWorkspaceId(block)
  // Unconditional so the hook order is stable; an empty alias simply misses.
  // The selector narrows the subscription to the ids — a re-render per edit to
  // one of the other pages would be pure noise.
  const claimants = useHandle(repo.query.aliasClaimants({workspaceId, alias: name}), {
    selector: rows => (rows ?? []).map(row => row.id),
  })
  const rivalIds = claimants.filter(id => id !== block.id)
  if (name.trim() === '' || workspaceId === '' || rivalIds.length === 0) return null
  const sharesTheName = claimants.length !== rivalIds.length

  const merge = async (): Promise<void> => {
    setMerging(true)
    try {
      await mergeAliasCollision(repo, {intoId: block.id, rivalIds, alias: name, workspaceId})
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
        {duplicateNameMessage(truncate(name, 40), rivalIds.length, sharesTheName)}
      </span>
      {/* The oldest rival. NOT necessarily where `[[Name]]` resolves — when
          this page is itself the oldest claimant, links land here — so this is
          "a page also called that", not "the page your links go to". */}
      <Button
        variant="ghost"
        size="sm"
        className="h-7"
        onClick={() => { void navigateFromGlobalCommand(repo, {blockId: rivalIds[0], workspaceId}) }}
      >
        Open it
      </Button>
      {/* The explanation and "Open it" still matter to a viewer — the name does
          not identify one page, whichever way the links currently fall — but
          the merge is a write they cannot make, so only that action goes. */}
      {!repo.isReadOnly && (
        <Button size="sm" className="h-7" disabled={merging} onClick={() => { void merge() }}>
          <Merge className="mr-1 h-3.5 w-3.5"/>
          Merge into this page
        </Button>
      )}
    </div>
  )
}

/** Pages only, and only when it is the page being read. */
export const duplicateNameBannerHeader: BlockHeaderContribution = ctx =>
  isFocalRender(ctx) && ctx.types.includes(PAGE_TYPE) ? DuplicateNameBanner : null

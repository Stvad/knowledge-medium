/** Inline backlink count badge + click-to-expand, for ordinary outline
 *  blocks (see `inlineBacklinksApplies` for the gate).
 *
 *  Two cooperating facet contributions, sharing one ephemeral expansion
 *  store (`expansionStore.ts`):
 *
 *    - a `blockContentDecorators` contribution overlays a small count pill
 *      on the block's content line. The pill shows only when the block has
 *      ≥1 backlink; clicking it toggles the expansion.
 *    - a `blockChildrenFooter` contribution renders the same backlinks-view
 *      section the focal block uses (`BacklinksViewSection`, so the block's
 *      Flat/Grouped choice is honoured) *after the block's children* when
 *      this block is expanded.
 *
 *  The count reuses the `backlinks.forBlock` handle (ids only, no
 *  hydration); the expensive list render happens only on expand. */
import type { Block } from '@/data/block'
import { useRepo } from '@/context/repo.js'
import { useWorkspaceId } from '@/hooks/block.js'
import {
  cachedContentDecorator,
  type BlockContentDecoratorContribution,
  type BlockChildrenFooterContribution,
  type BlockResolveContext,
} from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types.js'
import { GutterPill } from '@/components/GutterPill.js'
import { BacklinksViewSection } from '@/plugins/backlinks-view/BacklinksViewSection.js'
import { inlineBacklinksApplies } from './applies.ts'
import { useBacklinkCount } from './useBacklinkCount.ts'
import { toggleBacklinkExpansion, useBacklinkExpansion } from './expansionStore.ts'

// ──── Count pill (content decorator) ────

const InlineBacklinkCountBadge = ({
  block,
  Inner,
}: {
  block: Block
  Inner: BlockRenderer
}) => {
  const repo = useRepo()
  const workspaceId = useWorkspaceId(block, repo.activeWorkspaceId ?? '')
  const count = useBacklinkCount(block, workspaceId)
  const expanded = useBacklinkExpansion(block.id)

  // Reserve a right gutter (flex column) rather than absolutely overlaying
  // the count, so it never covers text at the end of a long line. With no
  // badge the content is the sole flex child and stays full width.
  return (
    <div className="flex w-full items-start gap-1">
      <div className="min-w-0 flex-1">
        <Inner block={block} />
      </div>
      {count > 0 && (
        <GutterPill
          count={count}
          expanded={expanded}
          onClick={() => toggleBacklinkExpansion(block.id)}
          label={`${count} linked reference${count === 1 ? '' : 's'}`}
        />
      )}
    </div>
  )
}

const decorate = cachedContentDecorator(InlineBacklinkCountBadge, 'WithInlineBacklinkCount')

export const inlineBacklinkCountDecoratorContribution: BlockContentDecoratorContribution = (ctx) =>
  inlineBacklinksApplies(ctx) ? decorate : null

// ──── Expanded references (children footer) ────

// Mounts (and subscribes to the shared count handle) only once expanded, so
// non-expanded blocks pay nothing here beyond the cheap expansion-store read.
const ExpandedBacklinks = ({
  block,
  resolveContext,
}: {
  block: Block
  resolveContext: BlockResolveContext
}) => {
  const repo = useRepo()
  const workspaceId = useWorkspaceId(block, repo.activeWorkspaceId ?? '')
  const count = useBacklinkCount(block, workspaceId)
  // Removing the last backlink while expanded also removes the badge pill
  // (count 0). Gate the section on count too, so we never strand the
  // "No backlinks" empty state inline with no pill left to collapse it —
  // the section just disappears with its last reference.
  if (count === 0) return null
  // Same coordinator the focal block uses, so the inline view honours the
  // block's Flat/Grouped choice and shares its (now compact) header.
  return <BacklinksViewSection block={block} resolveContext={resolveContext} />
}
ExpandedBacklinks.displayName = 'ExpandedBacklinks'

export const inlineBacklinkExpansionFooterContribution: BlockChildrenFooterContribution = (ctx) => {
  if (!inlineBacklinksApplies(ctx)) return null
  const Section: BlockRenderer = ({ block }) => {
    const expanded = useBacklinkExpansion(block.id)
    if (!expanded) return null
    return <ExpandedBacklinks block={block} resolveContext={ctx} />
  }
  Section.displayName = 'InlineBacklinkExpansion'
  return Section
}

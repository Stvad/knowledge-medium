/** Inline backlink count badge + click-to-expand, for ordinary outline
 *  blocks (see `inlineBacklinksApplies` for the gate).
 *
 *  Two cooperating facet contributions, sharing one ephemeral expansion
 *  store (`expansionStore.ts`):
 *
 *    - a `blockGutterItems` contribution puts a small count pill in the
 *      block's top-right gutter. The pill shows only when the block has
 *      ≥1 backlink; clicking it toggles the expansion.
 *    - a `blockBelowContent` contribution renders the same backlinks-view
 *      section the focal block uses (`BacklinksViewSection`, so the block's
 *      Flat/Grouped choice is honoured) *ahead of the block's children* when
 *      this block is expanded.
 *
 *  The count reuses the `backlinks.forBlock` handle (ids only, no
 *  hydration); the expensive list render happens only on expand. */
import type { Block } from '@/data/block'
import { useRepo } from '@/context/repo.js'
import { useWorkspaceId } from '@/hooks/block.js'
import type {
  BlockBelowContentContribution,
  BlockGutterItem,
  BlockGutterItemContribution,
  BlockResolveContext,
} from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types.js'
import { GutterPill } from '@/components/GutterPill.js'
import { BacklinksViewSection } from '@/plugins/backlinks-view/BacklinksViewSection.js'
import { inlineBacklinksApplies } from './applies.ts'
import { useBacklinkCount } from './useBacklinkCount.ts'
import { toggleBacklinkExpansion, useBacklinkExpansion } from './expansionStore.ts'

// ──── Count pill (gutter item) ────

const InlineBacklinkCountPill: BlockRenderer = ({block}) => {
  const repo = useRepo()
  const workspaceId = useWorkspaceId(block, repo.activeWorkspaceId ?? '')
  const count = useBacklinkCount(block, workspaceId)
  const expanded = useBacklinkExpansion(block.id)
  if (count === 0) return null
  return (
    <GutterPill
      count={count}
      expanded={expanded}
      onClick={() => toggleBacklinkExpansion(block.id)}
      label={`${count} linked reference${count === 1 ? '' : 's'}`}
    />
  )
}

const countPillItem: BlockGutterItem = {corner: 'top-right', component: InlineBacklinkCountPill}

export const inlineBacklinkCountItemContribution: BlockGutterItemContribution = (ctx) =>
  inlineBacklinksApplies(ctx) ? countPillItem : null

// ──── Expanded references ────

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

export const inlineBacklinkExpansionContribution: BlockBelowContentContribution = (ctx) => {
  if (!inlineBacklinksApplies(ctx)) return null
  const Section: BlockRenderer = ({ block }) => {
    const expanded = useBacklinkExpansion(block.id)
    if (!expanded) return null
    return <ExpandedBacklinks block={block} resolveContext={ctx} />
  }
  Section.displayName = 'InlineBacklinkExpansion'
  return Section
}

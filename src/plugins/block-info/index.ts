/** Block-info plugin — a metadata card on the block bullet.
 *
 *  Hover a bullet (desktop) to see when the block was created / last edited
 *  and by whom; the same card is reachable everywhere (touch included) via
 *  the bullet context menu's "Block info" item. Content is contributed
 *  through the core `blockBulletHoverFacet`; the bullet owns the hover /
 *  dialog mechanics. Toggle it off and the bullet reverts to a plain dot. */
import {
  blockBulletHoverFacet,
  type BlockBulletHoverContribution,
} from '@/extensions/blockInteraction.js'
import { dialogAppMountExtension } from '@/extensions/dialogAppMount.js'
import type { AppExtension } from '@/facets/facet'
import { systemToggle } from '@/facets/togglable'
import { BlockMetaCard } from './BlockMetaCard.tsx'

const blockInfoHoverContribution: BlockBulletHoverContribution = () => BlockMetaCard

export const blockInfoPlugin: AppExtension = systemToggle({
  id: 'system:block-info',
  name: 'Block info',
  description: 'Hover a block bullet (or open its context menu) to see when it was created / last edited and by whom.',
}).of([
  // The context-menu "Block info" item opens the card in a dialog, which is
  // inert without DialogHost mounted; pull it in (deduped by reference).
  dialogAppMountExtension,
  blockBulletHoverFacet.of(blockInfoHoverContribution, {source: 'block-info'}),
])

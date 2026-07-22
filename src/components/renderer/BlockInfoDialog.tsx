/**
 * Dialog form of the bullet hover-card — the touch / discoverability path.
 *
 * The desktop hover-card isn't reachable on touch (no hover) and isn't
 * obvious with a mouse either, so `BlockBullet` also exposes a "Block info"
 * context-menu item (right-click on desktop, long-press on mobile) that
 * opens this dialog. It renders the exact same `blockBulletHoverFacet`
 * sections, so there's a single source of content for both surfaces.
 */
import type { ReactElement } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.js'
import { ExtensionRenderBoundary } from '@/extensions/ExtensionRenderBoundary.js'
import { NestedBlockContextProvider } from '@/context/block.js'
import type { DialogContextProps } from '@/utils/dialogs.js'
import type { BlockRenderer } from '@/types.js'
import type { Block } from '@/data/block'

export interface BlockInfoDialogProps {
  block: Block
  sections: readonly BlockRenderer[]
  /** Panel the dialog was opened from — DialogHost mounts us as a sibling of
   *  the panel tree (no ambient panel context), so we re-seed it below and
   *  in-block links (author pages) target the originating panel instead of
   *  silently replacing the active one. */
  panelId?: string
}

export const BlockInfoDialog = ({
  block,
  sections,
  panelId,
  cancel,
}: DialogContextProps<null> & BlockInfoDialogProps): ReactElement => (
  // Non-modal + no overlay so author links stay navigable underneath (a
  // focus-trapping dimmed modal would leave the destination unreachable). Same
  // modal={false}+hideOverlay as ConsistencyAuditDialog, but we intentionally
  // keep Radix's default outside-click-to-dismiss — this is a disposable info
  // popup, not a task dialog whose state needs protecting.
  <Dialog
    open
    modal={false}
    onOpenChange={next => {
      if (!next) cancel()
    }}
  >
    <DialogContent hideOverlay className="max-w-xs">
      <DialogHeader>
        <DialogTitle>Block info</DialogTitle>
      </DialogHeader>
      {/* Only override when we actually have a panel, so a bare `undefined`
          can't blank an inherited panelId should DialogHost ever move under a
          panel-scoped context (today it mounts as a root-level sibling). */}
      <NestedBlockContextProvider overrides={panelId ? {panelId} : {}}>
        <div className="flex flex-col gap-2">
          {sections.map((Section, index) => (
            <ExtensionRenderBoundary key={index}>
              <Section block={block}/>
            </ExtensionRenderBoundary>
          ))}
        </div>
      </NestedBlockContextProvider>
    </DialogContent>
  </Dialog>
)

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
import { ErrorBoundary } from 'react-error-boundary'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.js'
import { FallbackComponent } from '@/components/util/error.js'
import type { DialogContextProps } from '@/utils/dialogs.js'
import type { BlockRenderer } from '@/types.js'
import type { Block } from '@/data/block'

export interface BlockInfoDialogProps {
  block: Block
  sections: readonly BlockRenderer[]
}

export const BlockInfoDialog = ({
  block,
  sections,
  cancel,
}: DialogContextProps<null> & BlockInfoDialogProps): ReactElement => (
  // Non-modal + no overlay: the card's author links navigate the app
  // underneath, so a focus-trapping dimmed modal would leave the destination
  // unreachable until the dialog is dismissed. Mirrors ConsistencyAuditDialog.
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
      <div className="flex flex-col gap-2">
        {sections.map((Section, index) => (
          <ErrorBoundary key={index} FallbackComponent={FallbackComponent}>
            <Section block={block}/>
          </ErrorBoundary>
        ))}
      </div>
    </DialogContent>
  </Dialog>
)

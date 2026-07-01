/**
 * Live-presence spike — shows other people in a shared workspace in real
 * time: the blocks they have selected/focused (coloured rings), their mouse
 * cursor, and their editor caret. Runs over Supabase Realtime (Presence for
 * identity + selection + caret, Broadcast for the cursor) — entirely beside
 * the kernel/PowerSync document path, so none of it is ever persisted.
 *
 * Seams used:
 *  - appEffectsFacet           → owns the Realtime channel + cursor broadcast
 *  - panelMountsFacet          → publishes the local user's selection/caret
 *  - blockShellDecoratorsFacet → remote-selection rings
 *  - appMountsFacet            → the mouse-cursor overlay
 *  - codeMirrorExtensionsFacet → remote editor carets
 *
 * SPIKE NOTE: defaults OFF — opt in per workspace via Extensions settings.
 * The channel is still PUBLIC, so enabling it globally must wait on Realtime
 * Authorization (private channel + RLS on `realtime.messages`); until then an
 * on-by-default public channel would let anyone with a workspace URL (ids
 * appear in URL hashes) observe or forge presence. See the security/privacy
 * caveats in `presenceClient.ts` (public channel → private + RLS; e2ee
 * metadata leak).
 */
import { appEffectsFacet, appMountsFacet, panelMountsFacet } from '@/extensions/core.js'
import { blockShellDecoratorsFacet } from '@/extensions/blockInteraction.js'
import { codeMirrorExtensionsFacet } from '@/editor/codeMirrorExtensions.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { presenceAppEffect } from './presenceEffect.js'
import { PresencePublisher } from './PresencePublisher.js'
import { RemoteCursorsOverlay } from './RemoteCursorsOverlay.js'
import { remoteSelectionShellDecorator } from './RemoteSelectionShellDecorator.js'
import { remoteCaretsCodeMirrorExtensions } from './remoteCaretsExtension.js'

const SOURCE = 'presence'

export const presencePlugin: AppExtension = systemToggle({
  id: 'system:presence',
  name: 'Live presence',
  description:
    "Shows other people in the workspace — their selected blocks, mouse cursors, and editor carets — over Supabase Realtime.",
  // Off by default: the channel is public for now, so this stays opt-in until
  // it's private + RLS-gated (see the module header).
  defaultEnabled: false,
}).of([
  appEffectsFacet.of(presenceAppEffect, { source: SOURCE }),
  panelMountsFacet.of(
    { id: 'presence.publisher', component: PresencePublisher },
    { source: SOURCE },
  ),
  blockShellDecoratorsFacet.of(remoteSelectionShellDecorator, { source: SOURCE }),
  appMountsFacet.of(
    { id: 'presence.cursors', component: RemoteCursorsOverlay },
    { source: SOURCE },
  ),
  codeMirrorExtensionsFacet.of(remoteCaretsCodeMirrorExtensions, { source: SOURCE }),
])

/**
 * Routes `ProcessorRejection` from `repo.tx` to the toast layer.
 *
 * Wired once at Repo bootstrap (`src/context/repo.tsx`) via
 * `repo.onUserError(surfaceProcessorRejection)`. Per-code formatting
 * lives here so the data layer stays UI-agnostic and we keep one
 * grep target for "what does this error code look like to the user."
 *
 * Today's codes:
 *   - `alias.collision` → emitted by the alias.sync same-tx processor
 *     when a block tries to claim an alias already held by a
 *     different live block.
 *
 * Adding a code: extend the switch + `meta` typing inside this file.
 * Don't sprinkle toast calls in processor code — keep the routing
 * in one place so the codes stay greppable.
 */

import type { ProcessorRejection } from '@/data/api'
import { showError } from './toast.ts'

interface AliasCollisionMeta {
  alias: string
  conflictingBlockId: string
  attemptedOn: string
}

const isAliasCollisionMeta = (meta: unknown): meta is AliasCollisionMeta =>
  meta !== null
  && typeof meta === 'object'
  && typeof (meta as AliasCollisionMeta).alias === 'string'
  && typeof (meta as AliasCollisionMeta).conflictingBlockId === 'string'
  && typeof (meta as AliasCollisionMeta).attemptedOn === 'string'

export const surfaceProcessorRejection = (error: ProcessorRejection): void => {
  switch (error.code) {
    case 'alias.collision': {
      if (!isAliasCollisionMeta(error.meta)) {
        // Defensive: meta shape mismatch shouldn't happen since both
        // ends are in this repo, but if it does we fall back to the
        // raw message rather than crashing.
        showError(error.message)
        return
      }
      const {alias} = error.meta
      showError(
        `Alias "${alias}" is already used by another block. Your edit was reverted — try a different name.`,
        {duration: 7000},
      )
      // TODO: add an action button that navigates to the conflicting
      // block once we have a stable navigation API for opening a
      // block by id from non-React contexts (the current navigation
      // helpers in `src/utils/navigation.ts` expect a workspace
      // context that we don't have here at error time).
      return
    }
    default: {
      // Unknown code — show the raw message. Better than swallowing
      // silently; any new processor that throws ProcessorRejection
      // surfaces SOMETHING until we add a tailored handler.
      showError(error.message)
    }
  }
}

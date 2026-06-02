/**
 * Routes `ProcessorRejection` from `repo.tx` to the toast layer.
 *
 * Wired once at Repo bootstrap (`src/context/repo.tsx`) via
 * `repo.onUserError(surfaceProcessorRejectionFor(repo))`. The repo
 * curried into the factory gives the action-button click handler
 * what it needs (`navigate(repo, ...)`) without each call site
 * threading it through.
 *
 * Per-code formatting lives here so the data layer stays UI-agnostic
 * and we keep one grep target for "what does this error code look
 * like to the user."
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

import { createElement } from 'react'
import type { ProcessorRejection } from '@/data/api'
import type { Repo } from '@/data/repo'
import { AliasCollisionToast } from './AliasCollisionToast.tsx'
import { showCustom, showError } from './toast.ts'

interface AliasCollisionMeta {
  alias: string
  conflictingBlockId: string
  conflictingBlockTitle: string
  workspaceId: string
  attemptedOn: string
  dropSourceAliases?: string[]
  collisionOrigin?: string
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

const isAliasCollisionMeta = (meta: unknown): meta is AliasCollisionMeta =>
  meta !== null
  && typeof meta === 'object'
  && typeof (meta as AliasCollisionMeta).alias === 'string'
  && typeof (meta as AliasCollisionMeta).conflictingBlockId === 'string'
  && typeof (meta as AliasCollisionMeta).conflictingBlockTitle === 'string'
  && typeof (meta as AliasCollisionMeta).workspaceId === 'string'
  && typeof (meta as AliasCollisionMeta).attemptedOn === 'string'
  && (
    (meta as AliasCollisionMeta).dropSourceAliases === undefined
    || isStringArray((meta as AliasCollisionMeta).dropSourceAliases)
  )
  && (
    (meta as AliasCollisionMeta).collisionOrigin === undefined
    || typeof (meta as AliasCollisionMeta).collisionOrigin === 'string'
  )

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`

export const surfaceProcessorRejectionFor = (repo: Repo) =>
  (error: ProcessorRejection): void => {
    switch (error.code) {
      case 'alias.collision': {
        if (!isAliasCollisionMeta(error.meta)) {
          // Defensive: meta shape mismatch shouldn't happen since both
          // ends are in this repo, but if it does we fall back to the
          // raw message rather than crashing.
          showError(error.message)
          return
        }
        const {
          alias,
          attemptedOn,
          conflictingBlockId,
          conflictingBlockTitle,
          workspaceId,
          dropSourceAliases,
        } = error.meta
        // Blank-title fallback: a block can legitimately claim an
        // alias with empty content, in which case the title would be
        // useless in the toast — fall back to showing the alias text.
        const displayTitle = conflictingBlockTitle.trim() === ''
          ? `"${alias}"`
          : `"${truncate(conflictingBlockTitle, 60)}"`
        const message = `Alias "${alias}" is already used by ${displayTitle}. Your edit was reverted — try a different name or merge with the existing page.`
        showCustom(
          id => createElement(AliasCollisionToast, {
            toastId: id,
            message,
            alias,
            attemptedOn,
            conflictingBlockId,
            conflictingBlockTitle,
            workspaceId,
            dropSourceAliases,
            repo,
          }),
          {duration: 12000},
        )
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

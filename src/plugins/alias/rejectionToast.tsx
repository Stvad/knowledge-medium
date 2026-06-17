/**
 * Alias plugin's handler for its own `alias.collision` ProcessorRejection.
 *
 * The alias.sync same-tx processor throws `ProcessorRejection {code:
 * 'alias.collision', meta}` when a block tries to claim an alias already
 * held by a different live block. This module owns everything the *user*
 * sees for that rejection — the meta shape, the copy, and the actionable
 * `AliasCollisionToast` — and contributes it through the generic
 * `rejectionToastFacet`. Core (`extensions/processorRejectionToast`)
 * stays ignorant of `alias.collision`: it just routes a rejection code to
 * whatever plugin registered for it.
 */
import { createElement } from 'react'
import type { ProcessorRejection } from '@/data/api'
import type { Repo } from '@/data/repo'
import { showCustom, showError } from '@/utils/toast.js'
import type { RejectionToastContribution } from '@/extensions/processorRejectionToast.js'
import { AliasCollisionToast } from './AliasCollisionToast.tsx'

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

/** `rejectionToastFacet` contribution for `alias.collision`. */
export const aliasCollisionRejectionToast: RejectionToastContribution = {
  code: 'alias.collision',
  handle: (error: ProcessorRejection, repo: Repo): void => {
    if (!isAliasCollisionMeta(error.meta)) {
      // Defensive: meta shape mismatch shouldn't happen since both ends
      // are in this repo, but if it does we fall back to the raw message
      // rather than crashing.
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
      collisionOrigin,
    } = error.meta
    // Blank-title fallback: a block can legitimately claim an alias with
    // empty content, in which case the title would be useless in the
    // toast — fall back to showing the alias text.
    const displayTitle = conflictingBlockTitle.trim() === ''
      ? `"${alias}"`
      : `"${truncate(conflictingBlockTitle, 60)}"`
    // `collisionOrigin: 'create'` — the rejected block was created in the
    // rolled-back tx, so it no longer exists and there is nothing to
    // merge from. Don't offer a merge that would fail.
    const offerMerge = collisionOrigin !== 'create'
    const message = offerMerge
      ? `Alias "${alias}" is already used by ${displayTitle}. Your edit was reverted — try a different name or merge with the existing page.`
      : `Alias "${alias}" is already used by ${displayTitle}. Nothing was created — try a different name.`
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
        offerMerge,
        repo,
      }),
      {duration: 12000},
    )
  },
}

/**
 * Alias plugin's toast for its own `alias.collision` ProcessorRejection.
 *
 * The alias.sync same-tx processor throws `ProcessorRejection {code:
 * 'alias.collision', meta}` when a block tries to claim an alias already
 * held by a different live block. This module owns everything the *user*
 * sees for that rejection — the meta shape, the copy, and the actionable
 * `AliasCollisionToast` — and contributes it through the generic
 * `rejectionToastFacet`. Core (`extensions/processorRejectionToast`) stays
 * ignorant of `alias.collision`: it just renders whatever the registered
 * contribution returns, inside its own `showCustom` envelope.
 */
import { createElement } from 'react'
import { truncate } from '@/utils/string'
import type { ProcessorRejection } from '@/data/api'
import type { Repo } from '@/data/repo'
import type { RejectionToastContribution } from '@/extensions/core.js'
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

/** `rejectionToastFacet` contribution for `alias.collision`. */
export const aliasCollisionRejectionToast: RejectionToastContribution = {
  code: 'alias.collision',
  render: (error: ProcessorRejection, repo: Repo, toastId: string | number) => {
    if (!isAliasCollisionMeta(error.meta)) {
      // Reachable when the conflicting block can't be resolved locally
      // (e.g. `conflictingBlockId` came back null), so there's nothing to
      // open/merge — show the raw message as the toast body. (Pre-inversion
      // this was a `showError`; the message is the same, only the styling/
      // duration follow the generic showCustom envelope now.)
      return createElement('span', null, error.message)
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
    return createElement(AliasCollisionToast, {
      toastId,
      message,
      alias,
      attemptedOn,
      conflictingBlockId,
      conflictingBlockTitle,
      workspaceId,
      dropSourceAliases,
      offerMerge,
      repo,
    })
  },
}

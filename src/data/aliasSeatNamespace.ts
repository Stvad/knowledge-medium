/**
 * The UUIDv5 namespace a workspace's alias seats are derived under (#719).
 *
 * A seat's id hashes the alias text, so a public namespace is the page-name
 * oracle described at {@link deriveWorkspaceIdNamespace}. Which namespace a
 * workspace gets, and why it is resolved before the write lock, is
 * `@/data/workspaceIdNamespace`'s; this module adds what is particular to
 * seats — the namespaces a seat may already sit under.
 *
 * Seats minted under the public namespace earlier keep their ids (#1297) and
 * stay recognized as seats; nothing mints or restores at them. A `[[name]]`
 * binds to one this device holds, by alias lookup. ACCEPTED: one it has not
 * downloaded yet gets a second page at the derived id — the old page is not on
 * this device to find — and #1297's re-id onto the derived slot ids converges
 * the two.
 */

import type { Tx } from '@/data/api'
import type { Repo } from '@/data/repo'
import {
  derivedIdNamespaceInTx,
  resolveDerivedIdNamespace,
  type DerivedIdNamespaceKind,
} from '@/data/workspaceIdNamespace'

export interface AliasSeatNamespaces {
  /** Where a seat is minted or restored. */
  readonly mint: string
  /** Every namespace a seat of this workspace may already sit under, `mint`
   *  first — for recognizing a seat, never for writing one. */
  readonly recognized: readonly string[]
}

const PUBLIC_ALIAS_SEAT_NS = 'a3c8a8c0-7c3a-4d2c-bc4f-1f6c2c6a7d11'

const ALIAS_SEAT_NAMESPACE: DerivedIdNamespaceKind = {
  label: 'km/alias-seat-ns/v1',
  plaintextNamespace: PUBLIC_ALIAS_SEAT_NS,
}

/** A plaintext workspace's answer. Not exported: a caller holding it would
 *  not have asked whether the workspace is plaintext. */
const PLAINTEXT_ALIAS_SEATS: AliasSeatNamespaces = Object.freeze({
  mint: PUBLIC_ALIAS_SEAT_NS,
  recognized: Object.freeze([PUBLIC_ALIAS_SEAT_NS]),
})

const seatsUnder = (mint: string): AliasSeatNamespaces =>
  mint === PUBLIC_ALIAS_SEAT_NS
    ? PLAINTEXT_ALIAS_SEATS
    : {mint, recognized: [mint, PUBLIC_ALIAS_SEAT_NS]}

/** PRE-LOCK: the namespaces for `workspaceId`'s seats, deriving and caching a
 *  sealed workspace's on first use. Throws `WorkspaceKeyUnavailableError` when
 *  that needs a key this device does not hold. */
export const resolveAliasSeatNamespaces = async (
  repo: Repo,
  workspaceId: string,
): Promise<AliasSeatNamespaces> =>
  seatsUnder(await resolveDerivedIdNamespace(repo, workspaceId, ALIAS_SEAT_NAMESPACE))

/** IN-LOCK: the namespaces for `workspaceId`'s seats, with the mode read
 *  through `tx` immediately before the caller writes. Throws
 *  `DerivedIdNamespaceUnavailableError` for a sealed workspace whose namespace
 *  was not resolved first; a caller that can leave the seat out — a derived
 *  reference — catches it. */
export const aliasSeatNamespacesInTx = async (
  tx: Tx,
  repo: Repo,
  workspaceId: string,
): Promise<AliasSeatNamespaces> =>
  seatsUnder(await derivedIdNamespaceInTx(tx, repo.user.id, workspaceId, ALIAS_SEAT_NAMESPACE))

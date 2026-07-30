/**
 * Write-boundary guard for CALLER-supplied block ids (issue #456).
 *
 * Every id minted INSIDE the app is already a canonical, lowercase UUID:
 * `crypto.randomUUID()` / the `uuid` package's `v4()` (repo.ts's default
 * `newId`), and every deterministic helper built on `uuid`'s `v5()`
 * (journalBlockId, dailyNoteBlockId, propertyDefinitionBlockId, the
 * roam-import / media-capture / alias-seat ids, …) — `uuid` never emits
 * uppercase hex. None of those call into this module; they don't need to,
 * and doing so unconditionally would break the many tests and internal
 * mutators (`tx.create`, `createChild`, …) that legitimately use short
 * mnemonic ids for readability. This module exists ONLY for the specific
 * entry points where an id arrives from OUTSIDE the app — the agent
 * bridge's `create-block` / `install-extension` commands today — see
 * `src/plugins/agent-runtime/commands.ts`.
 *
 * Closing this hole is what makes PR #447's outline-rendering hardening
 * (control-character/`%`/`]` percent-encoding) a defensive no-op instead of
 * a load-bearing display/addressability tradeoff: a canonical UUID never
 * contains anything `encodeOutlineId` needs to escape, so it round-trips
 * trivially and can never be visually confused with another id (no bidi
 * reordering, no homoglyphs, no ASCII lookalikes — the alphabet is just hex
 * + hyphen). See the issue's final comments for the full argument.
 */
import { UUID_RE_SOURCE } from './referenceBlock.js'

/** Canonical block-id shape: 32 lowercase hex digits as 8-4-4-4-12.
 *  Deliberately NO `i` flag — see the case-policy note on
 *  {@link InvalidBlockIdError}. Built from referenceBlock.ts's shared
 *  {@link UUID_RE_SOURCE} rather than a second copy of the character
 *  class. */
export const CANONICAL_BLOCK_ID_RE: RegExp = new RegExp(`^${UUID_RE_SOURCE}$`)

/**
 * A caller-supplied block id that isn't a canonical UUID.
 *
 * Case policy: lowercase is REQUIRED, not merely accepted — an uppercase or
 * mixed-case UUID is rejected rather than silently lowercased. Every internal
 * minter already produces lowercase (see the module docblock), so requiring
 * it from callers costs nothing in practice and sidesteps a real hazard:
 * normalizing a case-variant on the way in would make `create-block`
 * silently store an id DIFFERENT from the exact string the caller passed —
 * the same silent-mismatch failure mode `referenceBlockContentForId`
 * documents and refuses to paper over (referenceBlock.ts). Rejecting is
 * loud and actionable instead.
 */
export class InvalidBlockIdError extends Error {
  constructor(public readonly id: string, context: string) {
    super(
      `${context}: ${JSON.stringify(id)} is not a valid block id. Explicit ids must be a ` +
      'canonical UUID — 32 lowercase hex digits as 8-4-4-4-12 ' +
      '(e.g. "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"). Omit the id to have one minted ' +
      'automatically, or supply it in lowercase if it is already a UUID.',
    )
    this.name = 'InvalidBlockIdError'
  }
}

/** Throws {@link InvalidBlockIdError} unless `id` is a canonical (lowercase)
 *  UUID. `context` names the call site (e.g. "createBlock",
 *  "installExtension") so the error tells an agent or CLI user exactly
 *  which write it was. */
export const assertCanonicalBlockId = (id: string, context: string): void => {
  if (!CANONICAL_BLOCK_ID_RE.test(id)) {
    throw new InvalidBlockIdError(id, context)
  }
}

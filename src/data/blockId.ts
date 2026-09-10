/**
 * The block-id shape contract (issue #456): every block this app writes has a
 * canonical lowercase-UUID id.
 *
 * This is an invariant over the data, not a check on one caller, so it is
 * enforced at the tx engine's insert path (`buildNewBlockRow`) that every
 * local insert funnels through — the `Repo` owns the policy
 * ({@link BlockIdPolicy}, `RepoOptions.blockIdPolicy`, canonical by default);
 * the engine only carries it.
 *
 * NOT enforced, both deliberately, because both carry an id that already
 * exists rather than minting one:
 *
 *   - Rows arriving from SYNC — rejecting a peer's row can stall the sync
 *     stream on a row the server already accepted, a separate decision
 *     (issue #456).
 *   - `TxImpl.applyRaw`'s restore INSERT (undo/redo replay) — gating it
 *     wouldn't stop a foreign id from existing, it would only make UNDO
 *     fail on it.
 */
import { UUID_RE_SOURCE } from './referenceBlock.js'

/** Whether a `Repo`'s insert path requires canonical block ids.
 *
 *  `'canonical'` is the default and the only value production uses.
 *  `'any'` exists for the test harness (`createTestRepo`), which mints
 *  short mnemonic ids (`gen-1`, `root`, `T2`) precisely because they make
 *  a failing assertion readable — a 36-hex-digit id in
 *  `expect(childIds).toEqual([...])` is noise. That relaxation is a
 *  property of the test Repo, declared in one place, not a hole in the
 *  engine: the guard itself is pinned by `blockId.test.ts`, and its
 *  presence on the DEFAULT (unconfigured) Repo — the shape production
 *  constructs — by `txEngine.test.ts`. */
export type BlockIdPolicy = 'canonical' | 'any'

/** Canonical block-id shape: 32 lowercase hex digits as 8-4-4-4-12.
 *  Deliberately NO `i` flag — see the case-policy note on
 *  {@link InvalidBlockIdError}. Built from referenceBlock.ts's shared
 *  {@link UUID_RE_SOURCE} rather than a second copy of the character
 *  class.
 *
 *  Module-private on purpose: {@link assertCanonicalBlockId} is the whole
 *  API, so how the predicate is implemented stays free to change. Its case
 *  behaviour is covered by the uppercase/mixed-case rejection cases in
 *  blockId.test.ts, which hold for any implementation — an assertion on
 *  `.flags` would only restate this line. */
const CANONICAL_BLOCK_ID_RE = new RegExp(`^${UUID_RE_SOURCE}$`)

/**
 * A block id that isn't a canonical UUID.
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
 *  "installExtension", "tx.create") so the error tells an agent or CLI user
 *  exactly which write it was. */
export const assertCanonicalBlockId = (id: string, context: string): void => {
  if (!CANONICAL_BLOCK_ID_RE.test(id)) {
    throw new InvalidBlockIdError(id, context)
  }
}

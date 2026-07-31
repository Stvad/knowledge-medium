/**
 * The block-id shape contract (issue #456): every block this app writes has a
 * canonical lowercase-UUID id.
 *
 * Closing this hole is what makes PR #447's outline-rendering hardening
 * (control-character/`%`/`]` percent-encoding) a defensive no-op instead of
 * a load-bearing display/addressability tradeoff: a canonical UUID never
 * contains anything `encodeOutlineId` needs to escape, so it round-trips
 * trivially and can never be visually confused with another id (no bidi
 * reordering, no homoglyphs, no ASCII lookalikes — the alphabet is just hex
 * + hyphen). See the issue's final comments for the full argument.
 *
 * That argument only holds if it is an INVARIANT over the data, not a check
 * on one caller — anything downstream that leans on "an id can't contain a
 * newline" is wrong the moment a single write path skips the check. So the
 * enforcement point is the tx engine's insert path (`tx.create` /
 * `tx.createOrGet` → `buildNewBlockRow`), which every local block insert
 * funnels through: the kernel mutators (`createChild`,
 * `createSiblingAbove/Below`), `createTypedChild` — the documented record
 * shape for agent-authored extensions, which takes an explicit `id` — the
 * bridge's `create-block` / `install-extension`, importers, and any write
 * path added later, without each having to remember. The `Repo` owns the
 * decision ({@link BlockIdPolicy}, `RepoOptions.blockIdPolicy`, canonical by
 * default); the engine only carries it.
 *
 * In practice this constrains nothing the app already does. Every id minted
 * INSIDE the app is already a canonical lowercase UUID: `crypto.randomUUID()`
 * / the `uuid` package's `v4()` (repo.ts's default `newId`), and every
 * deterministic helper built on `uuid`'s `v5()` (kernelPageBlockId,
 * dailyNoteBlockId, propertyDefinitionBlockId, pluginBlockId, the roam-import
 * / media-capture / alias-seat ids, …) — `uuid` never emits uppercase hex.
 * A survey of the owner's live data found 0 non-conforming ids across 347,244
 * blocks in 3 workspaces, so there is no grandfather path to keep.
 *
 * NOT enforced, both deliberately, and both for the same reason — they carry
 * an id that already exists rather than minting one:
 *
 *   - Rows arriving from SYNC. The Layout B observer materializes
 *     `blocks_synced` into `blocks` directly, below this engine. Rejecting a
 *     peer's row is a strictly stronger and riskier claim (it can stall the
 *     sync stream on a row the server already accepted) and issue #456 calls
 *     it out as a separate decision.
 *   - `TxImpl.applyRaw`'s restore INSERT (undo/redo replay). Gating it would
 *     not stop a foreign id from existing — it is already in the user's data
 *     by one of the routes above — it would only make UNDO fail on it, which
 *     trades a tolerated id for lost history.
 *
 * The outline-renderer hardening from #447 stays regardless: it is what
 * covers any id this guard didn't mint.
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

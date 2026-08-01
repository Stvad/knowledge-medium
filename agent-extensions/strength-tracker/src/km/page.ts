/** Per-workspace bootstrap: the Strength Log page and its settings block.
 *
 *  The page is a kernel page — a deterministic per-workspace singleton with
 *  a human alias — so workouts and layoffs have a stable home and the same
 *  row converges across offline clients. The settings block is a lazily
 *  created child holding the engine knobs; the program content itself is
 *  read from the plan outline, not stored here.
 */

import {ChangeScope} from '@/data/api/index.js'
import type {Block} from '@/data/block.js'
import {getOrCreateKernelPage, kernelPageBlockId} from '@/data/kernelPage.js'
import {hasBlockType} from '@/data/properties.js'
import type {Repo} from '@/data/repo.js'
import {
  adoptTypedBlock, createTypedChild, getOrCreateTypedChild, type DerivedIdentity,
} from '@/data/typedRecords.js'

import {SETTINGS_TYPE, STRENGTH_LOG_TYPE} from './schema'

type TypeSnapshot = ReturnType<Repo['snapshotTypeRegistries']>

// A fresh, randomly-generated uuid-v5 namespace for this page kind, so its
// deterministic id can never collide with another kernel page.
const STRENGTH_LOG_NS = 'b7e1d4c2-9a63-4f80-8c15-3e6d5a2f9b04'
const STRENGTH_LOG_ALIAS = 'Strength Log'

/** The page if it already exists, WITHOUT creating it.
 *
 *  Reading the program must not bootstrap: the start flow reads before it
 *  asks, and a preview you cancel would otherwise leave a real synced page
 *  and settings block behind — for no session. */
export const findStrengthLogPage = async (
  repo: Repo,
  workspaceId: string,
): Promise<string | null> => {
  const id = kernelPageBlockId(workspaceId, STRENGTH_LOG_NS)
  const block = await repo.load(id)
  return block && !block.deleted ? id : null
}

/** The settings block if it already exists, WITHOUT creating it. */
export const findSettingsBlock = async (
  repo: Repo,
  workspaceId: string,
  pageId: string,
): Promise<string | null> =>
  (await repo.queryBlocks({workspaceId, types: [SETTINGS_TYPE]}))
    .find(block => block.parentId === pageId)?.id ?? null

export const getOrCreateStrengthLogPage = (repo: Repo, workspaceId: string): Promise<Block> =>
  getOrCreateKernelPage(repo, workspaceId, {
    namespace: STRENGTH_LOG_NS,
    alias: STRENGTH_LOG_ALIAS,
    markerType: STRENGTH_LOG_TYPE,
  })

/** The settings block's seat under its page — one per page, forever.
 *
 *  A sibling scan inside the transaction only makes two bootstraps on ONE
 *  device converge. Two OFFLINE devices each see no sibling, each mint a
 *  random id, and after sync the page holds two settings blocks with
 *  `findSettingsBlock` taking whichever the query returns first — so the two
 *  devices read and write different plan roots, rollover hours and `or`-group
 *  choices, with nothing on screen to say why. Opening the log now creates
 *  this block, so that is a thing two devices routinely do at once.
 *
 *  This is the shape a derived id is actually for: a singleton whose identity
 *  is "the settings of this page", nothing positional about it and nothing to
 *  enumerate — the same reason the layoff record has one. */
const SETTINGS_NS = '636f6b8e-e5b0-43cc-a8da-de3e31646feb'
export const settingsIdentity = (pageId: string): DerivedIdentity =>
  ({namespace: SETTINGS_NS, key: pageId})

const settingsSpec = (pageId: string, typeSnapshot: TypeSnapshot) => ({
  parentId: pageId,
  content: 'Strength settings',
  position: {kind: 'last'} as const,
  types: [SETTINGS_TYPE],
  typeSnapshot,
})

/** Get or create the settings child under the page. */
export const getOrCreateSettingsBlock = async (
  repo: Repo,
  workspaceId: string,
  pageId: string,
): Promise<string> => {
  const existing = await repo.queryBlocks({workspaceId, types: [SETTINGS_TYPE]})
  const here = existing.find(b => b.parentId === pageId)
  if (here) return here.id

  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(async tx => {
    const seat = await getOrCreateTypedChild(repo, tx, {
      identity: settingsIdentity(pageId),
      // Parentage only — deliberately NOT the type as well.
      //
      // `getOrCreateTypedChild` re-tags a missing type on adopt, which is
      // exactly the repair this record wants: the derived id resolves to this
      // page's settings block whatever tags it carries, so a block that lost
      // `strength-settings` is still findable and still holds the real plan
      // root, rollover hour, cadence and `or`-group choice children. Demanding
      // the tag here rejected it, and a rejected seat is permanent — the
      // fallback below then minted a BLANK settings block beside it and every
      // later read silently used the empty one. Losing the tag is a slip; the
      // config is not, and the two must not be the same event.
      //
      // (`isStandingToday` requires its type, and the difference is that a
      // workout has no id-based lookup at all — it is found by a workspace-wide
      // scan BY type, so tolerating a missing tag there is unimplementable
      // rather than merely stricter.)
      //
      // Parentage stays, because `findSettingsBlock` is parent-scoped: adopting
      // a block dragged off the page would hand back knobs the reader cannot
      // find, so the two would disagree about which block the settings are in.
      adoptable: block => block.parentId === pageId,
      ...settingsSpec(pageId, typeSnapshot),
    })
    if (seat.status !== 'taken') return seat.id

    // The seat holds a tombstone, or something that is no longer this page's
    // settings, and neither ever becomes untaken. Find the mint a previous
    // call made before making another, or every open adds a block.
    //
    // Defence in depth, not the load-bearing half: the query at the top of
    // this function already returns any settings block under the page, so a
    // repeat open short-circuits long before reaching here — mutation-tested,
    // and a blind mint in this branch breaks no test through the public path.
    // It covers the window where that query has not yet seen a mint of its
    // own, which is real but not reproducible from outside.
    const minted = (await tx.childrenOf(pageId, undefined, {hidePropertyChildren: true}))
      .find(block => !block.deleted && block.id !== seat.id && hasBlockType(block, SETTINGS_TYPE))
    return minted !== undefined
      ? (await adoptTypedBlock(repo, tx, minted, [SETTINGS_TYPE], typeSnapshot)).id
      : createTypedChild(repo, tx, settingsSpec(pageId, typeSnapshot))
    // Structural block creation is BlockDefault; the individual setting
    // *values* carry their own UserPrefs scope when the user edits them.
  }, {scope: ChangeScope.BlockDefault, description: 'Create strength settings'})
}

/** Per-workspace bootstrap: the Strength Log page and its settings block.
 *
 *  The page is a kernel page — a deterministic per-workspace singleton with
 *  a human alias — so workouts and layoffs have a stable home and the same
 *  row converges across offline clients. The settings block is a lazily
 *  created child holding the engine knobs; the program content itself is
 *  read from the plan outline, not stored here.
 */

import {ChangeScope} from '@/data/api/index.js'
import type {BlockData} from '@/data/api/index.js'
import type {Block} from '@/data/block.js'
import {getOrCreateKernelPage, kernelPageBlockId} from '@/data/kernelPage.js'
import {hasBlockType} from '@/data/properties.js'
import type {Repo} from '@/data/repo.js'
import {
  adoptTypedBlock, createTypedChild, derivedBlockId, getOrCreateTypedChild, type DerivedIdentity,
} from '@/data/typedRecords.js'

import {FIELD} from './fields'
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

/** The settings block if it already exists, WITHOUT creating it.
 *
 *  Reading must not bootstrap: `readProgram` runs on the Start path, and this
 *  returning `null` where the writer would have found something is how Start
 *  came to stamp a session from the built-in program while a configured
 *  settings block sat in the outline — plan root, rollover hour and every
 *  `or`-group choice ignored until the log page happened to be opened. So the
 *  rule itself lives in `locateSettings`, shared with the writer. */
export const findSettingsBlock = async (
  repo: Repo,
  workspaceId: string,
  pageId: string,
): Promise<string | null> => (await locateSettings(repo, workspaceId, pageId))?.id ?? null

/** Any of the settings values, which is what makes a block the settings block
 *  when its type tag is not there to say so. */
const carriesSettings = (block: BlockData): boolean =>
  [FIELD.planRoot, FIELD.rolloverHour, FIELD.cadenceDays, FIELD.roundTo]
    .some(name => block.properties[name] !== undefined)

/** The one ordered rule for "where are this page's settings", used by the
 *  reader AND the writer so they cannot name different blocks — which they did
 *  twice: once when the reader demanded a type tag the writer had stopped
 *  demanding, and once when their two lookups ran in different orders.
 *
 *  1. The TAGGED block under the page. Ordinary, and what everything that has
 *     been opened once since the derived seat landed will hit.
 *  2. The derived SEAT, tag or no tag. What repairs a block that lost its type
 *     — `getOrCreateSettingsBlock` says why losing a tag must not lose config.
 *  3. An untagged page child that CARRIES settings values. Blocks minted
 *     before the seat existed have random ids, so neither of the above can
 *     reach one that has also lost its tag, and the next open would mint a
 *     blank one at the seat and abandon the plan root, rollover hour, cadence
 *     and choice children still sitting in the outline. `typedRecords.ts`
 *     requires exactly this when a derived id is retrofitted onto a kind that
 *     already has rows out there, and this workspace has one.
 *
 *     Keyed on the VALUES rather than on content or position, so it identifies
 *     the block by the thing worth rescuing. A legacy block holding no settings
 *     is not matched — and has nothing to lose by not being. */
const locateSettings = async (
  repo: Repo,
  workspaceId: string,
  pageId: string,
): Promise<BlockData | null> => {
  const tagged = (await repo.queryBlocks({workspaceId, types: [SETTINGS_TYPE]}))
    .find(block => block.parentId === pageId)
  if (tagged) return tagged

  const seat = await repo.load(derivedBlockId(settingsIdentity(pageId)))
  // The same conditions the writer's `adoptable` applies, and no type check.
  if (seat && !seat.deleted && seat.parentId === pageId) return seat

  const legacy = ((await repo.block(pageId).children.load()) ?? [])
    .find(block => !block.deleted && carriesSettings(block))
  return legacy ?? null
}

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
  // The SAME ordered rule the reader uses, not a lookup of its own — see
  // `locateSettings`. When it finds a block the writer's job is to make sure it
  // is tagged, which is all `adoptTypedBlock` does; when it finds nothing, fall
  // through to the seat.
  const found = await locateSettings(repo, workspaceId, pageId)
  const typeSnapshot = repo.snapshotTypeRegistries()
  if (found) {
    if (hasBlockType(found, SETTINGS_TYPE)) return found.id
    return repo.tx(
      async tx => (await adoptTypedBlock(repo, tx, found, [SETTINGS_TYPE], typeSnapshot)).id,
      {scope: ChangeScope.BlockDefault, description: 'Repair strength settings'},
    )
  }

  return repo.tx(async tx => {
    const seat = await getOrCreateTypedChild(repo, tx, {
      identity: settingsIdentity(pageId),
      // Parentage only — deliberately NOT the type as well. The derived id
      // resolves to this page's settings block whatever tags it carries, and
      // `getOrCreateTypedChild` re-tags a missing one on adopt. Demanding the
      // tag rejected it instead, and a rejected seat is permanent, so the
      // fallback minted a BLANK settings block and every later read used the
      // empty one — plan root, rollover hour and choice children abandoned.
      // Losing a tag is a slip; losing the config is not.
      // (`isStandingToday` DOES require its type: a workout has no id-based
      // lookup, so tolerating a missing tag there is unimplementable.)
      //
      // Parentage stays because `findSettingsBlock` is parent-scoped — adopting
      // a block dragged off the page would hand back knobs the reader cannot
      // find, and the two would disagree about where the settings are.
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

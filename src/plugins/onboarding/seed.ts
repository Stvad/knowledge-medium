import { v4 as uuidv4 } from 'uuid'
import { ChangeScope } from '@/data/api'
import type { Tx } from '@/data/api'
import type { TypeRegistrySnapshot } from '@/data/api/blockType'
import type { Repo } from '@/data/repo'
import { aliasesProp } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { keysBetween } from '@/data/orderKey'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { propertySchemasFacet, typesFacet } from '@/data/facets'
import { mergeLiftedSchemas } from '@/data/internals/refProjection'
// Onboarding's plugin dependencies: the demo blocks tag themselves with these
// plugins' block types, so we fold their type/schema contributions into the
// seed snapshot below. This makes seeding self-sufficient — it doesn't matter
// how much of the app runtime has been applied to the repo when seedTutorial
// runs (at bootstrap it's only the kernel types), because addTypeInTx resolves
// against the snapshot we pass, not the repo's live registry.
import { todoDataExtension } from '@/plugins/todo/dataExtension'
import { characterCounterDataExtension } from '@/plugins/character-counter/dataExtension'
import { srsReschedulingDataExtension } from '@/plugins/srs-rescheduling/dataExtension'
import { geoDataExtension } from '@/plugins/geo/dataExtension'
import {
  EXTENSIONS_PAGE_TITLE,
  extensionsPageOutline,
  tutorialOutline,
  TUTORIAL_DEFAULT_TITLE,
  TUTORIAL_VIM_TITLE,
  type TutorialNode,
} from './outline'

const DEMO_TYPE_EXTENSIONS = [
  todoDataExtension,
  characterCounterDataExtension,
  srsReschedulingDataExtension,
  geoDataExtension,
]

/** Type/schema snapshot for seeding: the repo's current registries (kernel
 *  PAGE/EXTENSION types) overlaid with the demo plugins' types + lifted
 *  schemas. Resolved from the dependency data-extensions so the typed demos
 *  (todo / char-counter / srs / place / map) seed correctly even before the
 *  full app runtime is applied to the repo. */
const seedTypeSnapshot = (repo: Repo): TypeRegistrySnapshot => {
  const base = repo.snapshotTypeRegistries()
  const rt = resolveFacetRuntimeSync(DEMO_TYPE_EXTENSIONS)
  // typesFacet / propertySchemasFacet are keyed-map facets, so `read` returns
  // Maps (id → type, name → schema). mergeLiftedSchemas folds type-lifted
  // fields (char:limit, place:lat, …) into the schema map.
  const depTypes = rt.read(typesFacet)
  const depSchemas = mergeLiftedSchemas(rt.read(propertySchemasFacet), depTypes)

  const types = new Map(base.types)
  for (const [id, t] of depTypes) types.set(id, t)
  const propertySchemas = new Map(base.propertySchemas)
  for (const [name, s] of depSchemas) propertySchemas.set(name, s)
  return { types, propertySchemas }
}

/**
 * Seeds the starter Tutorial subtree on a freshly-created personal
 * workspace. Three parent-less pages are written in one tx:
 *
 *   - `Tutorial` (default / non-vim variant; the landing target — vim is
 *     off by default, so this matches the shipped keymap)
 *   - `Tutorial (vim)` (variant for users who enable vim mode)
 *   - `extensions` (shared page that holds the explanatory bullets and
 *     the seven example-extension source blocks; both Tutorial variants
 *     link to it via `[[extensions]]` so the examples aren't duplicated)
 *
 * The two Tutorial variants share one outline builder so their
 * structure stays in sync between variants. Reachable from the landing
 * daily note via a `[[Tutorial]]` bullet that the daily-notes landing
 * resolver prepends on first run; the vim variant is reachable from a
 * cross-link bullet at the top of the default Tutorial.
 *
 * All inserts run in a single `repo.tx` so the whole subtree appears
 * atomically AND the cross-page wiki links resolve correctly — every
 * alias row exists before `parseReferences` (the post-commit processor)
 * runs against the bullets that reference the other pages. Returns the
 * id of the default Tutorial so callers can use it as a tutorial-first
 * landing target.
 */
export const seedTutorial = async (
  repo: Repo,
  workspaceId: string,
): Promise<string> => {
  const vimTutorialId = uuidv4()
  const defaultTutorialId = uuidv4()
  const extensionsPageId = uuidv4()
  const typeSnapshot = seedTypeSnapshot(repo)

  // Three parent-less pages; their root order keys don't really matter
  // (parent=null means no canonical sibling list) but `tx.create`
  // requires one.
  const [vimKey, defaultKey, extensionsKey] = keysBetween(null, null, 3)

  await repo.tx(
    async tx => {
      await seedPage(repo, tx, typeSnapshot, {
        id: vimTutorialId,
        workspaceId,
        orderKey: vimKey,
        title: TUTORIAL_VIM_TITLE,
        aliases: [TUTORIAL_VIM_TITLE],
        children: tutorialOutline('vim'),
      })
      await seedPage(repo, tx, typeSnapshot, {
        id: defaultTutorialId,
        workspaceId,
        orderKey: defaultKey,
        title: TUTORIAL_DEFAULT_TITLE,
        aliases: [TUTORIAL_DEFAULT_TITLE],
        children: tutorialOutline('default'),
      })
      await seedPage(repo, tx, typeSnapshot, {
        id: extensionsPageId,
        workspaceId,
        orderKey: extensionsKey,
        title: EXTENSIONS_PAGE_TITLE,
        aliases: [EXTENSIONS_PAGE_TITLE],
        children: extensionsPageOutline(),
      })
    },
    { scope: ChangeScope.BlockDefault, description: 'seed tutorial' },
  )

  return defaultTutorialId
}

interface SeedPageArgs {
  id: string
  workspaceId: string
  orderKey: string
  title: string
  aliases: string[]
  children: ReadonlyArray<TutorialNode>
}

const seedPage = async (
  repo: Repo,
  tx: Tx,
  typeSnapshot: ReturnType<Repo['snapshotTypeRegistries']>,
  args: SeedPageArgs,
): Promise<void> => {
  await tx.create({
    id: args.id,
    workspaceId: args.workspaceId,
    parentId: null,
    orderKey: args.orderKey,
    content: args.title,
  })
  await repo.addTypeInTx(
    tx,
    args.id,
    PAGE_TYPE,
    { [aliasesProp.name]: args.aliases },
    typeSnapshot,
  )
  await seedChildren(repo, tx, typeSnapshot, args.workspaceId, args.id, args.children)
}

const seedChildren = async (
  repo: Repo,
  tx: Tx,
  typeSnapshot: ReturnType<Repo['snapshotTypeRegistries']>,
  workspaceId: string,
  parentId: string,
  nodes: ReadonlyArray<TutorialNode>,
): Promise<void> => {
  if (nodes.length === 0) return
  const keys = keysBetween(null, null, nodes.length)
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const id = node.id ?? uuidv4()
    await tx.create({
      id,
      workspaceId,
      parentId,
      orderKey: keys[i],
      content: node.content,
      properties: node.properties,
    })
    if (node.type) {
      await repo.addTypeInTx(tx, id, node.type, node.typeProperties ?? {}, typeSnapshot)
    }
    if (node.children && node.children.length > 0) {
      await seedChildren(repo, tx, typeSnapshot, workspaceId, id, node.children)
    }
  }
}

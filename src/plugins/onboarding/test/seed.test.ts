// @vitest-environment node
/**
 * Tests for `seedTutorial` — the personal-workspace bootstrap helper
 * that lays down the Tutorial subtree. Two parent-less Tutorial pages
 * are written from a shared outline builder (`tutorialOutline`):
 *   - `Tutorial` (default / non-vim variant; the landing target)
 *   - `Tutorial (vim)` (variant for users who enable vim mode)
 *
 * Each page carries its canonical alias, the outline sections (Welcome,
 * basics, navigation, …), and an `extensions/` sub-page whose children
 * are one block per example extension. The pages land in a single
 * `repo.tx`; the demo comment threads follow, each in its own.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { aliasesProp, isCollapsedProp } from '@/data/properties'
import { EXTENSION_TYPE, HTML_DOCUMENT_TYPE, PAGE_TYPE } from '@/data/blockTypes'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { releaseTestRepos } from '@/data/test/testRepoScope'
import { Repo } from '@/data/repo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { typeSeedsFacet } from '@/data/facets'
import { staticDataExtensions } from '@/extensions/staticDataExtensions'
import { TODO_TYPE } from '@/plugins/todo/schema'
import { CHAR_COUNTER_TYPE, WORD_COUNTER_TYPE } from '@/plugins/character-counter/blockType'
import { charLimitProp } from '@/plugins/character-counter/properties'
import { SRS_SM25_TYPE } from '@/plugins/srs-rescheduling/schema'
import { MAP_TYPE, PLACE_TYPE } from '@/plugins/geo/blockTypes'
import { placeLatProp } from '@/plugins/geo/properties'
import { resolveAnchor } from '@/plugins/annotations/anchor'
import { THREAD_TYPE, threadAnchorOf, threadReplacementOf, threadTargetIdOf } from '@/plugins/annotations/schema'
import { seedTutorial } from '../seed'
import { exampleExtensions } from '@/extensions/exampleExtensions'
import {
  EXTENSIONS_PAGE_TITLE,
  TUTORIAL_DEFAULT_TITLE,
  TUTORIAL_VIM_TITLE,
  tutorialOutline,
  type TutorialNode,
} from '../outline'
import { TUTORIAL_TYPE_EXTENSIONS } from './tutorialTypeExtensions'
import { annotationsDataExtension } from '@/plugins/annotations/dataExtension'

const WS = 'ws-1'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (extensions = TUTORIAL_TYPE_EXTENSIONS): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  // Mirror production: at construction the Repo gets its data-layer types from
  // `setFacetRuntime` (see src/context/repo.tsx). Here we install just the
  // tutorial's demo types so `repo.snapshotTypeRegistries()` resolves them at
  // seed time.
  const { repo } = createTestRepo({
    db: h.db,
    user: { id: 'user-1' },
    extensions,
  })
  return { h, repo }
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

const listAllBlockIds = async (h: TestDb): Promise<string[]> => {
  const rows = await h.db.getAll<{ id: string }>('SELECT id FROM blocks WHERE deleted = 0')
  return rows.map(r => r.id)
}

const threadRootsIn = async (h: TestDb, repo: Repo) => {
  const ids = await listAllBlockIds(h)
  for (const id of ids) await repo.load(id)
  return ids.map(id => repo.block(id)).filter(b => b.hasType(THREAD_TYPE)).map(b => b.peek()!)
}

const demoComments = (nodes: readonly TutorialNode[]): string[] =>
  nodes.flatMap(node => [
    ...(node.thread?.comment ? [node.thread.comment] : []),
    ...demoComments(node.children ?? []),
  ])

const findPageByAlias = async (h: TestDb, repo: Repo, alias: string): Promise<string | null> => {
  for (const id of await listAllBlockIds(h)) {
    await repo.load(id)
    const aliases = repo.block(id).peekProperty(aliasesProp)
    if (Array.isArray(aliases) && aliases.includes(alias)) return id
  }
  return null
}

// A seed writes the whole tutorial outline into a real repo — hundreds of
// blocks through the tx layer, ~0.5s of genuine work on an idle machine.
// These cases only READ what one seed wrote, so they share it.
describe('seedTutorial', {timeout: 30_000}, () => {
  let tutorialId: string
  beforeAll(async () => {
    env = await setup()
    tutorialId = await seedTutorial(env.repo, WS)
  }, 30_000)
  // Built before any per-test repo scope opens, so the global release never
  // reaches it.
  afterAll(async () => { await releaseTestRepos([env.repo]) })

  it('returns the default Tutorial root id (the landing target)', async () => {
    expect(typeof tutorialId).toBe('string')
    expect(tutorialId).toMatch(/^[0-9a-f-]{36}$/)

    await env.repo.load(tutorialId)
    const tutorial = env.repo.block(tutorialId)
    const data = tutorial.peek()
    expect(data?.parentId).toBeNull()
    expect(data?.workspaceId).toBe(WS)
    expect(data?.content).toBe(TUTORIAL_DEFAULT_TITLE)
    expect(tutorial.peekProperty(aliasesProp)).toEqual([TUTORIAL_DEFAULT_TITLE])
    expect(tutorial.hasType(PAGE_TYPE)).toBe(true)
  })

  it('also creates a parent-less Tutorial (vim) page with the canonical alias', async () => {
    const vimId = await findPageByAlias(env.h, env.repo, TUTORIAL_VIM_TITLE)
    expect(vimId).not.toBeNull()
    const page = env.repo.block(vimId!)
    const data = page.peek()
    expect(data?.parentId).toBeNull()
    expect(data?.content).toBe(TUTORIAL_VIM_TITLE)
    expect(page.peekProperty(aliasesProp)).toEqual([TUTORIAL_VIM_TITLE])
    expect(page.hasType(PAGE_TYPE)).toBe(true)
  })

  it('seeds the typed feature demos with their real plugin types', async () => {
    const ids = await listAllBlockIds(env.h)
    for (const id of ids) await env.repo.load(id)
    const blocks = ids.map(id => env.repo.block(id))
    const hasTyped = (typeId: string) => blocks.some(b => b.hasType(typeId))

    expect(hasTyped(TODO_TYPE)).toBe(true)
    expect(hasTyped(SRS_SM25_TYPE)).toBe(true)
    expect(hasTyped(MAP_TYPE)).toBe(true)
    expect(hasTyped(WORD_COUNTER_TYPE)).toBe(true)
    expect(hasTyped(HTML_DOCUMENT_TYPE)).toBe(true)

    // Char-counter demo carries its type-lifted `char:limit` (set via addType).
    const charBlock = blocks.find(b => b.hasType(CHAR_COUNTER_TYPE))
    expect(charBlock?.peekProperty(charLimitProp)).toBe(280)

    // Two Place demos under the map — one pair per Tutorial variant (vim +
    // default), so four in total, pinned at their own coordinates.
    const places = blocks.filter(b => b.hasType(PLACE_TYPE))
    expect(places).toHaveLength(4)
    expect([...new Set(places.map(b => b.peekProperty(placeLatProp)))].sort())
      .toEqual([48.8584, 48.8606])
  })

  it('seeds advanced sections collapsed and keeps essentials expanded', async () => {
    await env.repo.load(tutorialId, { descendants: true })

    const childIds = await env.repo.block(tutorialId).childIds.load()
    const sectionByContent = new Map(
      childIds.map(id => [env.repo.block(id).peek()?.content ?? '', env.repo.block(id)]),
    )

    // Essentials open by default…
    expect(sectionByContent.get('Welcome')?.peekProperty(isCollapsedProp)).toBeFalsy()
    // …deeper sections seed collapsed (the codec-backed boolean round-trips
    // through the seeder's raw properties map).
    expect(sectionByContent.get('On mobile')?.peekProperty(isCollapsedProp)).toBe(true)
  })

  it('seeds the outline as a tree of children under each Tutorial page', async () => {
    await env.repo.load(tutorialId, { descendants: true })

    const tutorial = env.repo.block(tutorialId)
    const childIds = await tutorial.childIds.load()
    // The outline has many top-level sections (Welcome, basics,
    // navigation, …, extensions). Asserting the exact count would make
    // this brittle against future copy-edits; just sanity-check it's
    // multi-section.
    expect(childIds.length).toBeGreaterThan(5)
  })

  it('seeds a shared parent-less `extensions` page with the example extension blocks underneath', async () => {
    const extensionsId = await findPageByAlias(env.h, env.repo, EXTENSIONS_PAGE_TITLE)
    expect(extensionsId).not.toBeNull()
    await env.repo.load(extensionsId!, { descendants: true })
    const extensionsPage = env.repo.block(extensionsId!)
    expect(extensionsPage.peek()?.parentId).toBeNull()
    expect(extensionsPage.hasType(PAGE_TYPE)).toBe(true)

    // Each example lives under its own title bullet, so the EXTENSION_TYPE
    // source blocks are grandchildren of the extensions page rather than
    // direct children. Walk the subtree and filter by type.
    const subtree = await env.repo.query.subtree({ id: extensionsId! }).load()
    const extensionTyped = subtree
      .filter(row => row.id !== extensionsId)
      .map(row => env.repo.block(row.id))
      .filter(b => b.hasType(EXTENSION_TYPE))
    expect(extensionTyped).toHaveLength(exampleExtensions.length)

    // Every example source from the registered list appears under the
    // page, irrespective of order in the subtree walk.
    const contents = new Set(extensionTyped.map(b => b.peek()?.content))
    for (const ex of exampleExtensions) {
      expect(contents.has(ex.source)).toBe(true)
    }
  })

  it('writes the pages in a single tx', async () => {
    const rows = await env.h.db.getAll<{ description: string | null }>('SELECT description FROM command_events')
    expect(rows.filter(row => row.description === 'seed tutorial')).toHaveLength(1)
    // The pages' tx, the Comments page annotations creates for the first
    // thread, and one tx per demo thread: a split page write adds a row.
    expect(rows).toHaveLength(1 + 1 + 4)
  })

  it('leaves one undo step for the whole seed', () => {
    expect(env.repo.undoManagerFor(WS).depths(ChangeScope.BlockDefault).undo).toBe(1)
  })

  it('starts a demo comment thread and a demo edit suggestion in each variant, anchored exactly', async () => {
    const roots = await threadRootsIn(env.h, env.repo)
    expect(roots).toHaveLength(4)

    for (const root of roots) {
      const target = env.repo.block(threadTargetIdOf(root)!).peek()!
      const anchor = threadAnchorOf(root)
      expect(anchor.kind).toBe('range')
      if (anchor.kind === 'range') expect(resolveAnchor(target.content, anchor).state).toBe('exact')
    }
    expect(roots.map(threadReplacementOf).filter(Boolean)).toEqual(['receive', 'receive'])

    const [comment] = demoComments(tutorialOutline('default'))
    const firstComments = await Promise.all(roots.filter(root => !threadReplacementOf(root)).map(async root =>
      (await env.repo.block(root.id).childIds.load()).map(id => env.repo.block(id).peek()?.content)))
    expect(firstComments).toEqual([[comment], [comment]])
  })

  // The seed runs at bootstrap against the Repo's construction-time registry,
  // which is built from `staticDataExtensions` (see src/context/repo.tsx). So
  // every block type the tutorial tags a demo with MUST be registered there,
  // or `addType` throws and no tutorial seeds (the original char-counter / geo
  // regression). Guard the production list directly — no DB, no processors.
  // A type reaches the merged `repo.types` via a `typeSeedsFacet` seed
  // (synthesised into repo.types by the facet bridge) — the sole
  // registration channel now that the static `typesFacet` is gone (Slice D).
  it('staticDataExtensions registers every block type the tutorial seeds', () => {
    const runtime = resolveFacetRuntimeSync(staticDataExtensions)
    const typeIds = new Set<string>(
      runtime.read(typeSeedsFacet).map(t => t.id),
    )
    for (const typeId of [
      TODO_TYPE, CHAR_COUNTER_TYPE, WORD_COUNTER_TYPE, SRS_SM25_TYPE, MAP_TYPE, PLACE_TYPE,
      HTML_DOCUMENT_TYPE, THREAD_TYPE,
    ]) {
      expect(typeIds.has(typeId)).toBe(true)
    }
  })
})

describe('seedTutorial when a demo thread cannot be written', {timeout: 30_000}, () => {
  it('still seeds the pages and returns the tutorial', async () => {
    // Without the annotations types, every thread write refuses.
    env = await setup(TUTORIAL_TYPE_EXTENSIONS.filter(ext => ext !== annotationsDataExtension))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    let tutorialId: string
    try {
      tutorialId = await seedTutorial(env.repo, WS)
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('demo comments failed'), expect.any(Error))
    } finally {
      logged.mockRestore()
    }
    await env.repo.load(tutorialId)
    expect(env.repo.block(tutorialId).peek()?.content).toBe(TUTORIAL_DEFAULT_TITLE)
    expect(await findPageByAlias(env.h, env.repo, TUTORIAL_VIM_TITLE)).not.toBeNull()
  })
})

describe('seedTutorial into a workspace with a properties-migration mode', {timeout: 30_000}, () => {
  beforeEach(async () => { env = await setup() })

  it.each(['cell', 'children'] as const)('seeds extension demos before their definitions are enabled in %s mode', async mode => {
    await env.h.db.execute(
      `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
        encryption_mode, properties_migration) VALUES (?, 'test', 'user-1', 1, 1, 'none', ?)`,
      [WS, mode],
    )
    env.repo.setActiveWorkspaceId(WS)
    expect(env.repo.propertySchemaResolverFor(WS).resolve('user:hello').status)
      .toBe('identity-unavailable')
    const tutorialId = await seedTutorial(env.repo, WS)
    await env.repo.load(tutorialId, { descendants: true })

    const allIds = await listAllBlockIds(env.h)
    for (const id of allIds) await env.repo.load(id)
    const blocks = allIds.map(id => env.repo.block(id))
    expect(await threadRootsIn(env.h, env.repo)).toHaveLength(4)
    for (const [extension, property] of [['hello-renderer', 'user:hello'], ['split-layout', 'user:layout']]) {
      const demo = blocks.find(b => b.peek()?.content.startsWith(`Try it: enable \`${extension}\``))
      expect(demo?.peek()?.content).toContain(property)
      expect(demo?.peek()?.content).toContain('then add')
      expect(blocks.every(b => b.peek()?.properties[property] === undefined)).toBe(true)
    }
  })
})

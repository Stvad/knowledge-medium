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
 * are one block per example extension. All inserts run in a single
 * `repo.tx` so both pages land atomically.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { aliasesProp, isCollapsedProp } from '@/data/properties'
import { EXTENSION_TYPE, PAGE_TYPE } from '@/data/blockTypes'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { TODO_TYPE } from '@/plugins/todo/schema'
import { CHAR_COUNTER_TYPE } from '@/plugins/character-counter/blockType'
import { charLimitProp } from '@/plugins/character-counter/properties'
import { SRS_SM25_TYPE } from '@/plugins/srs-rescheduling/schema'
import { MAP_TYPE, PLACE_TYPE } from '@/plugins/geo/blockTypes'
import { placeLatProp } from '@/plugins/geo/properties'
import { seedTutorial } from '../seed'
import { exampleExtensions } from '@/extensions/exampleExtensions'
import {
  EXTENSIONS_PAGE_TITLE,
  TUTORIAL_DEFAULT_TITLE,
  TUTORIAL_VIM_TITLE,
} from '../outline'

const WS = 'ws-1'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  // Plain repo — only the kernel PAGE/EXTENSION types Repo installs by default,
  // exactly like the bootstrap phase where seedTutorial runs. This proves the
  // seed is self-sufficient: it folds the demo plugins' types into its own
  // snapshot (see seedTypeSnapshot), so the typed demos seed without the app
  // runtime having registered those plugins on the repo.
  const repo = new Repo({
    db: h.db,
    cache,
    user: { id: 'user-1' },
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
  })
  return { h, repo }
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })
// Dispose the per-test Repo's sync observer so its db.onChange subscription
// doesn't leak onto the shared DB (closed once in afterAll).
afterEach(() => { env.repo.stopSyncObserver() })

const listAllBlockIds = async (h: TestDb): Promise<string[]> => {
  const rows = await h.db.getAll<{ id: string }>('SELECT id FROM blocks WHERE deleted = 0')
  return rows.map(r => r.id)
}

const findPageByAlias = async (h: TestDb, repo: Repo, alias: string): Promise<string | null> => {
  for (const id of await listAllBlockIds(h)) {
    await repo.load(id)
    const aliases = repo.block(id).peekProperty(aliasesProp)
    if (Array.isArray(aliases) && aliases.includes(alias)) return id
  }
  return null
}

describe('seedTutorial', () => {
  it('returns the default Tutorial root id (the landing target)', async () => {
    const tutorialId = await seedTutorial(env.repo, WS)
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
    await seedTutorial(env.repo, WS)
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
    await seedTutorial(env.repo, WS)
    const ids = await listAllBlockIds(env.h)
    for (const id of ids) await env.repo.load(id)
    const blocks = ids.map(id => env.repo.block(id))
    const hasTyped = (typeId: string) => blocks.some(b => b.hasType(typeId))

    expect(hasTyped(TODO_TYPE)).toBe(true)
    expect(hasTyped(SRS_SM25_TYPE)).toBe(true)
    expect(hasTyped(MAP_TYPE)).toBe(true)

    // Char-counter demo carries its type-lifted `char:limit` (set via addType).
    const charBlock = blocks.find(b => b.hasType(CHAR_COUNTER_TYPE))
    expect(charBlock?.peekProperty(charLimitProp)).toBe(280)

    // Two Place demos under the map — one pair per Tutorial variant (vim +
    // default), so four in total, pinned at their own coordinates.
    const places = blocks.filter(b => b.hasType(PLACE_TYPE))
    expect(places).toHaveLength(4)
    expect([...new Set(places.map(b => b.peekProperty(placeLatProp)))].sort())
      .toEqual([40.6892, 48.8584])
  })

  it('seeds advanced sections collapsed and keeps essentials expanded', async () => {
    const tutorialId = await seedTutorial(env.repo, WS)
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
    const tutorialId = await seedTutorial(env.repo, WS)
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
    await seedTutorial(env.repo, WS)

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

  it('seeds a hello-renderer demo block carrying the user:hello gating property', async () => {
    const tutorialId = await seedTutorial(env.repo, WS)
    await env.repo.load(tutorialId, { descendants: true })

    const allIds = await listAllBlockIds(env.h)
    for (const id of allIds) await env.repo.load(id)
    const helloDemo = allIds
      .map(id => env.repo.block(id))
      .find(b => b.peek()?.properties['user:hello'] === true)
    expect(helloDemo).toBeDefined()
  })

  it('all inserts share a single tx — exactly one command_events row', async () => {
    await seedTutorial(env.repo, WS)
    const rows = await env.h.db.getAll<{ count: number }>(
      'SELECT COUNT(*) AS count FROM command_events',
    )
    expect(rows[0]?.count).toBe(1)
  })
})

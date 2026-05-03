// @vitest-environment node
/**
 * Tests for `seedTutorial` — the personal-workspace bootstrap helper
 * that lays down the Tutorial subtree (root + intro README + sample
 * renderer block + extensions parent + one block per example
 * extension). All inserts run inside one `repo.tx`, so the whole
 * subtree appears atomically.
 *
 * Coverage:
 *   - Creates a parent-less Tutorial page with the canonical alias
 *   - Returns the tutorial root id
 *   - Lays down the intro + sample renderer children with the right
 *     properties
 *   - Lays down the extensions parent + one child per example
 *     extension, all tagged type=extension
 *   - All inserts share a single tx (one command_events row)
 *
 * Replaces deleted `src/test/initData.test.ts` (legacy `Repo`/`Block`
 * surface). The new test runs through the real commit pipeline via
 * `createTestDb`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aliasesProp, typeProp, rendererProp } from '@/data/properties'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '../data/repo'
import { seedTutorial } from '@/initData'
import { exampleExtensions, TUTORIAL_README } from '@/extensions/exampleExtensions'

const WS = 'ws-1'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
    // Don't run parseReferences — TUTORIAL_README may contain
    // wikilinks which would create alias targets we'd then have to
    // count around. Tests focus on what seedTutorial writes.
    registerKernelProcessors: false,
  })
  return {h, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

describe('seedTutorial', () => {
  it('creates a parent-less Tutorial page with the canonical alias', async () => {
    const tutorialId = await seedTutorial(env.repo, WS)
    await env.repo.load(tutorialId)
    const tutorial = env.repo.block(tutorialId)
    const data = tutorial.peek()

    expect(data?.parentId).toBeNull()
    expect(data?.workspaceId).toBe(WS)
    expect(data?.content).toBe('Tutorial')
    expect(tutorial.peekProperty(aliasesProp)).toEqual(['Tutorial'])
  })

  it('returns the tutorial root id from the helper', async () => {
    const tutorialId = await seedTutorial(env.repo, WS)
    expect(typeof tutorialId).toBe('string')
    expect(tutorialId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('lays down the intro README + sample renderer block as children', async () => {
    const tutorialId = await seedTutorial(env.repo, WS)
    await env.repo.load(tutorialId, {descendants: true})

    const tutorial = env.repo.block(tutorialId)
    const childIds = await tutorial.childIds.load()
    // Three direct children: intro, sample, extensions parent
    expect(childIds.length).toBe(3)

    const intro = env.repo.block(childIds[0])
    expect(intro.peek()?.content).toBe(TUTORIAL_README)

    const sample = env.repo.block(childIds[1])
    expect(sample.peek()?.content).toBe('A block that uses the hello-renderer extension')
    expect(sample.peekProperty(rendererProp)).toBe('hello-renderer')
  })

  it('creates an extensions parent labeled "extensions" with the canonical alias', async () => {
    const tutorialId = await seedTutorial(env.repo, WS)
    await env.repo.load(tutorialId, {descendants: true})

    const childIds = await env.repo.block(tutorialId).childIds.load()
    const extensionsParent = env.repo.block(childIds[2])
    expect(extensionsParent.peek()?.content).toBe('extensions')
    expect(extensionsParent.peekProperty(aliasesProp)).toEqual(['extensions'])
  })

  it('seeds one block per example extension, all tagged type=extension', async () => {
    const tutorialId = await seedTutorial(env.repo, WS)
    await env.repo.load(tutorialId, {descendants: true})

    const tutorialChildIds = await env.repo.block(tutorialId).childIds.load()
    const extensionsParent = env.repo.block(tutorialChildIds[2])
    const extBlockIds = await extensionsParent.childIds.load()
    const extBlocks = extBlockIds.map(id => env.repo.block(id))

    expect(extBlocks).toHaveLength(exampleExtensions.length)
    for (const block of extBlocks) {
      expect(block.peekProperty(typeProp)).toBe('extension')
    }
    // Source content matches example extensions in declaration order.
    expect(extBlocks.map(b => b.peek()?.content)).toEqual(
      exampleExtensions.map(e => e.source),
    )
  })

  it('all inserts share a single tx — exactly one command_events row', async () => {
    await seedTutorial(env.repo, WS)
    const rows = await env.h.db.getAll<{count: number}>(
      'SELECT COUNT(*) AS count FROM command_events',
    )
    expect(rows[0]?.count).toBe(1)
  })
})

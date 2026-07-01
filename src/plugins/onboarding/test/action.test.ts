// @vitest-environment node
/**
 * Tests for `insertTutorialIntoWorkspace` — the core of the "Insert
 * tutorial" command-palette action. The action lets a user drop the
 * Tutorial subtree into ANY workspace (the auto-seed in `landing.ts`
 * only fires on the user's first, freshly-created workspace).
 *
 * The behaviour worth pinning is idempotency: re-running must NOT mint a
 * second `Tutorial` page, because two pages sharing the `Tutorial` alias
 * would make `[[Tutorial]]` lookups ambiguous. The alias index
 * (`block_aliases`) is trigger-maintained and synchronous, so the guard
 * sees the first seed's page immediately. The toast / navigation / hash
 * resolution in the action wrapper aren't covered here — they're thin
 * glue around this function.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { todoDataExtension } from '@/plugins/todo/dataExtension'
import { characterCounterDataExtension } from '@/plugins/character-counter/dataExtension'
import { srsReschedulingDataExtension } from '@/plugins/srs-rescheduling/dataExtension'
import { geoDataExtension } from '@/plugins/geo/dataExtension'
import { insertTutorialIntoWorkspace } from '../action'
import { TUTORIAL_DEFAULT_TITLE } from '../outline'

const WS = 'ws-1'

// Same minimal demo-type set as seed.test.ts — enough for the typed demos
// to tag themselves, without the references/alias post-commit processors.
const TUTORIAL_TYPE_EXTENSIONS = [
  todoDataExtension,
  characterCounterDataExtension,
  srsReschedulingDataExtension,
  geoDataExtension,
]

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const { repo } = createTestRepo({
    db: sharedDb.db,
    user: { id: 'user-1' },
    extensions: TUTORIAL_TYPE_EXTENSIONS,
  })
  return { h: sharedDb, repo }
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

const countTutorialPages = async (): Promise<number> => {
  const rows = await env.h.db.getAll<{ n: number }>(
    `SELECT COUNT(*) AS n FROM block_aliases
     WHERE workspace_id = ? AND alias = ?`,
    [WS, TUTORIAL_DEFAULT_TITLE],
  )
  return rows[0]?.n ?? 0
}

describe('insertTutorialIntoWorkspace', () => {
  it('seeds the Tutorial when the workspace has none', async () => {
    const result = await insertTutorialIntoWorkspace(env.repo, WS)

    expect(result.alreadyExisted).toBe(false)
    expect(result.tutorialId).toMatch(/^[0-9a-f-]{36}$/)
    expect(await countTutorialPages()).toBe(1)

    await env.repo.load(result.tutorialId)
    expect(env.repo.block(result.tutorialId).peek()?.content).toBe(TUTORIAL_DEFAULT_TITLE)
  })

  it('is idempotent: re-running returns the existing page and adds no duplicate', async () => {
    const first = await insertTutorialIntoWorkspace(env.repo, WS)
    const second = await insertTutorialIntoWorkspace(env.repo, WS)

    expect(second.alreadyExisted).toBe(true)
    expect(second.tutorialId).toBe(first.tutorialId)
    expect(await countTutorialPages()).toBe(1)
  })
})

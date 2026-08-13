// @vitest-environment node
/**
 * Integration tests for the alias.sync same-tx processor (cases A1,
 * A2, A3, AR1 in docs/alias-rename-cases.html). Runs the full
 * pipeline through `repo.tx` so the same-tx runner actually fires
 * inside the user's writeTransaction.
 *
 * Cross-block cascading (rename processor's R1/R4 rewriting source
 * backlinks) is covered in `src/plugins/references/test/renameProcessor.test.ts`.
 *
 * Collision rejection is exercised below in the "collision" describe
 * block — these test that a colliding edit throws ProcessorRejection
 * and rolls back the whole user tx atomically.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { aliasesProp, typesProp } from '@/data/properties'
import { EXTENSION_TYPE } from '@/data/blockTypes'
import { dailyNotesDataExtension } from '@/plugins/daily-notes'
import { referencesDataExtension } from '@/plugins/references/dataExtension.js'
import { aliasDataExtension } from '../dataExtension.ts'

interface Harness {
  h: TestDb
  cache: BlockCache
  repo: Repo
  read(id: string): Promise<{id: string; content: string; deleted: 0 | 1; properties_json: string} | null>
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo, cache } = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
    extensions: [
      dailyNotesDataExtension,
      referencesDataExtension,
      aliasDataExtension,
    ],
  })
  return {
    h,
    cache,
    repo,
    read: async id => h.db.getOptional(
      `SELECT id, content, deleted, properties_json FROM blocks WHERE id = ?`,
      [id],
    ),
  }
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  env = await setup()
  vi.useFakeTimers({shouldAdvanceTime: true})
})
afterEach(async () => {
  vi.useRealTimers()
})

const WS = 'ws-1'

const flush = async () => {
  await vi.advanceTimersByTimeAsync(1)
  await env.repo.awaitProcessors()
}

const readAliases = async (id: string): Promise<string[]> => {
  const row = await env.read(id)
  if (row === null) return []
  return (JSON.parse(row.properties_json).alias ?? []) as string[]
}

/** The LOCAL derived column (PR #288 slice A) — not exposed by `env.read`. */
const readReferenceTargetId = async (id: string): Promise<string | null> => {
  const row = await sharedDb.db.get<{reference_target_id: string | null}>(
    'SELECT reference_target_id FROM blocks WHERE id = ?', [id],
  )
  return row.reference_target_id
}

const createTarget = async (
  id: string,
  content: string,
  aliases: string[],
): Promise<void> => {
  await env.repo.tx(async tx => {
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content})
    await tx.setProperty(id, aliasesProp, aliases)
  }, {scope: ChangeScope.BlockDefault})
  await flush()
}

describe('alias.sync — Case A1 (content edit, old value is an alias)', () => {
  it('rewrites the alias entry to the new content', async () => {
    await createTarget('t', 'Old name', ['Old name'])
    await env.repo.mutate.setContent({id: 't', content: 'New name'})
    await flush()

    expect((await env.read('t'))!.content).toBe('New name')
    expect(await readAliases('t')).toEqual(['New name'])
  })
})

describe('alias.sync — Case A2 (content edit, new value already an alias)', () => {
  it('replaces old content entry and dedupes against the existing alias', async () => {
    await createTarget('t', 'X', ['X', 'Y'])
    await env.repo.mutate.setContent({id: 't', content: 'Y'})
    await flush()

    expect((await env.read('t'))!.content).toBe('Y')
    expect(await readAliases('t')).toEqual(['Y'])
  })
})

describe('alias.sync — Case A3 (drift heal)', () => {
  it('adds new content as a fresh alias when old content is not an alias', async () => {
    await createTarget('t', 'already drifted', ['Original'])
    await env.repo.mutate.setContent({id: 't', content: 'another edit'})
    await flush()

    expect((await env.read('t'))!.content).toBe('another edit')
    expect(await readAliases('t')).toEqual(['Original', 'another edit'])
  })
})

describe('alias.sync — Case AR1 (alias rename, content matches removed alias)', () => {
  it('rewrites content to the added alias', async () => {
    await createTarget('t', 'Foo', ['Foo'])
    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, ['Bar']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('t'))!.content).toBe('Bar')
    expect(await readAliases('t')).toEqual(['Bar'])
  })

  // AR1 rewrites `content` from a PLUGIN same-tx processor, i.e. after the
  // kernel's `core.deriveReferenceTarget` already ran — and AR1's own
  // precondition is that content did NOT change in this tx, so derive never
  // fired for the row at all. Without an inline recompute the derived column
  // is left describing pre-rewrite content. Reachable when the aliases being
  // swapped are themselves spelled as references (PR #386 review).
  it('re-derives reference_target_id for the content it rewrites', async () => {
    await createTarget('page-foo', 'Foo page', ['Foo'])
    await createTarget('page-bar', 'Bar page', ['Bar'])
    // `t` is an exact `[[Foo]]` reference whose ALIAS is the literal
    // string `[[Foo]]` — that string equality is what arms AR1.
    await createTarget('t', '[[Foo]]', ['[[Foo]]'])
    expect(await readReferenceTargetId('t')).toBe('page-foo')

    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, ['[[Bar]]']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    // AR1 fired: content now names Bar...
    expect((await env.read('t'))!.content).toBe('[[Bar]]')
    // ...so the column must follow it, not keep pointing at Foo. A stale
    // stamp here is what makes a row keep classifying as the WRONG property
    // definition's field row in a child-backed workspace.
    expect(await readReferenceTargetId('t')).toBe('page-bar')
  })
})

describe('alias.sync — non-aliased blocks', () => {
  it('does not promote a plain block into an aliased one on content edit', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'plain', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'hello'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    await env.repo.mutate.setContent({id: 'plain', content: 'world'})
    await flush()
    expect(await readAliases('plain')).toEqual([])
  })
})

describe('alias.sync — blank-content guard', () => {
  it('clearing content does NOT add `""` to the alias list (A1 path)', async () => {
    await createTarget('t', 'Old', ['Old'])
    await env.repo.mutate.setContent({id: 't', content: ''})
    await flush()

    expect((await env.read('t'))!.content).toBe('')
    // Aliases stay as ["Old"]; sync refuses to write a blank alias
    // entry. The alias index ignores empty strings anyway, so this
    // would just pollute the alias list.
    expect(await readAliases('t')).toEqual(['Old'])
  })

  it('A3 drift heal does not append `""` either', async () => {
    await createTarget('t', 'already drifted', ['Original'])
    await env.repo.mutate.setContent({id: 't', content: ''})
    await flush()

    expect((await env.read('t'))!.content).toBe('')
    expect(await readAliases('t')).toEqual(['Original'])
  })

  it('AR1 does not rewrite content to `""` when an alias is renamed to empty', async () => {
    await createTarget('t', 'Foo', ['Foo'])
    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, ['']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    expect((await env.read('t'))!.content).toBe('Foo')
  })
})

describe('alias.sync — rapid title edits', () => {
  it('two back-to-back content edits each commit content+alias atomically', async () => {
    // Same-tx sync amends each user tx so content + aliases commit
    // together. There's no stale-plan window — each tx is
    // independently coherent. After two rapid edits, end state is
    // determined by the second edit alone.
    await createTarget('t', 'Old', ['Old'])

    await env.repo.mutate.setContent({id: 't', content: 'New name'})
    await env.repo.mutate.setContent({id: 't', content: 'Brand new'})
    await flush()

    expect((await env.read('t'))!.content).toBe('Brand new')
    expect(await readAliases('t')).toEqual(['Brand new'])
  })
})

// These drive the REAL processor through `repo.tx`, on the live fixture
// shape: an extension block whose alias list is `[slug, <its own source>]`.
describe('alias.sync — opaque-content blocks have no content↔alias parity', () => {
  const SOURCE = 'import {actionsFacet} from "@/extensions/core.js"\nexport default 1'

  const createExtensionBlock = async (aliases: string[]): Promise<void> => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'ext',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        content: SOURCE,
        properties: {types: [EXTENSION_TYPE]},
      })
      await tx.setProperty('ext', aliasesProp, aliases)
    }, {scope: ChangeScope.BlockDefault})
    await flush()
  }

  // Covers the content → alias leg (the Rule 1/2 drift-heal).
  it('does not mirror a source bundle into the alias list on a content change', async () => {
    await createExtensionBlock(['readwise'])
    await env.repo.mutate.setContent({id: 'ext', content: `${SOURCE}\n// v2`})
    await flush()

    expect(await readAliases('ext')).toEqual(['readwise'])
  })

  // Covers the alias → content leg (the `after.content === removed[0]`
  // rename branch) — the one that WRITES to content.
  it('does not overwrite content when an alias equal to it is renamed', async () => {
    await createExtensionBlock(['readwise', SOURCE])
    await env.repo.tx(
      tx => tx.setProperty('ext', aliasesProp, ['readwise', 'cleaned up']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('ext'))!.content).toBe(SOURCE)
  })

  // Pins the EITHER-side gate: whole-tx snapshots mean a detag + alias
  // edit in one tx arrives with `after` already non-opaque, so an
  // `after`-only gate falls through to the data-loss branch above.
  it('holds when the opaque type is removed in the SAME tx as an alias edit', async () => {
    await createExtensionBlock(['readwise', SOURCE])

    await env.repo.tx(async tx => {
      await tx.setProperty('ext', typesProp, [])
      await tx.setProperty('ext', aliasesProp, ['readwise', 'cleaned up'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    expect((await env.read('ext'))!.content).toBe(SOURCE)
  })

  // Same transition, forward direction: detag + content edit must not
  // re-trigger the drift-heal append that created #541.
  it('holds when the opaque type is removed in the SAME tx as a content edit', async () => {
    await createExtensionBlock(['readwise'])

    await env.repo.tx(async tx => {
      await tx.setProperty('ext', typesProp, [])
      await tx.update('ext', {content: `${SOURCE}\n// v2`})
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    expect(await readAliases('ext')).toEqual(['readwise'])
  })

  // The gate is about the block, not the operation: an ordinary page
  // still mirrors both ways, so this can't be read as "parity is off".
  it('still syncs an ordinary block', async () => {
    await createTarget('page', 'Old name', ['Old name'])
    await env.repo.mutate.setContent({id: 'page', content: 'New name'})
    await flush()

    expect(await readAliases('page')).toEqual(['New name'])
  })
})

describe('alias.sync — convergence', () => {
  it('second pass after sync writes is a no-op (A1 cascade)', async () => {
    await createTarget('t', 'Old name', ['Old name'])
    await env.repo.mutate.setContent({id: 't', content: 'New name'})
    await flush()
    const propsAfterFirst = (await env.read('t'))!.properties_json

    // A second flush after no input edits should not change anything.
    await flush()
    expect((await env.read('t'))!.properties_json).toBe(propsAfterFirst)
  })
})

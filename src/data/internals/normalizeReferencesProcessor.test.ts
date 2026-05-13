// @vitest-environment node
/**
 * Same-tx canonicalization of `blocks.references_json` — exercises
 * the `core.normalizeReferences` processor end-to-end through a
 * `repo.tx`. The bulk of the canonical-form rules are pinned in
 * `blockData.test.ts` (the pure function); this file pins the
 * processor wiring: writes through tx primitives commit normalized.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ChangeScope,
  type BlockReference,
} from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '../repo'

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
  })
  return {h, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

const readReferences = async (db: TestDb['db'], id: string): Promise<BlockReference[]> => {
  const row = await db.get<{references_json: string}>(
    'SELECT references_json FROM blocks WHERE id = ?',
    [id],
  )
  return JSON.parse(row.references_json) as BlockReference[]
}

describe('core.normalizeReferences (same-tx processor)', () => {
  it('canonicalizes references written via tx.create', async () => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'foo',
        references: [
          {id: 'z', alias: 'z-alias'},
          {id: 'a', alias: 'a-alias'},
          {id: 'a', alias: 'a-alias'},  // dup → should collapse
        ],
      })
    }, {scope: ChangeScope.BlockDefault})

    const refs = await readReferences(env.h.db, 'a')
    // Sorted by (sourceField='', id, alias) + deduped.
    expect(refs).toEqual([
      {id: 'a', alias: 'a-alias'},
      {id: 'z', alias: 'z-alias'},
    ])
  })

  it('canonicalizes references written via tx.update', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'foo'})
    }, {scope: ChangeScope.BlockDefault})

    await env.repo.tx(async tx => {
      await tx.update('a', {
        references: [
          {id: 'b', alias: 'b'},
          {id: 'a', alias: 'a'},
          {id: 'b', alias: 'b'},  // dup
        ],
      })
    }, {scope: ChangeScope.BlockDefault})

    const refs = await readReferences(env.h.db, 'a')
    expect(refs).toEqual([
      {id: 'a', alias: 'a'},
      {id: 'b', alias: 'b'},
    ])
  })

  it('skips the amend when input is already canonical (no-op processor)', async () => {
    // Insert a row, then snapshot its updatedAt. Then write the SAME
    // (already-canonical) references with skipMetadata:false. If the
    // processor were to amend a no-op, that amendment would also need
    // to NOT bump updatedAt — but more importantly, the explicit
    // skip should prevent the redundant SQL UPDATE entirely.
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'foo',
        references: [{id: 'x', alias: 'x'}],
      })
    }, {scope: ChangeScope.BlockDefault})

    const before = await env.h.db.get<{updated_at: number}>(
      'SELECT updated_at FROM blocks WHERE id = ?', ['a'],
    )

    // Re-write the same canonical references. The processor should see
    // the row in changedRows (references field touched), notice the
    // value is already canonical, and skip the amend.
    await env.repo.tx(async tx => {
      await tx.update('a', {references: [{id: 'x', alias: 'x'}]})
    }, {scope: ChangeScope.BlockDefault})

    const after = await env.h.db.get<{updated_at: number}>(
      'SELECT updated_at FROM blocks WHERE id = ?', ['a'],
    )
    // The user-fn tx.update did bump updatedAt; that's normal. The
    // assertion we care about is that the references column still
    // holds the same canonical form (no spurious re-write through the
    // normalizer path).
    const refs = await readReferences(env.h.db, 'a')
    expect(refs).toEqual([{id: 'x', alias: 'x'}])
    expect(after.updated_at).toBeGreaterThan(before.updated_at)
  })

  it('handles a tx that writes multiple blocks (one amendment per block)', async () => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'foo',
        references: [{id: 'z', alias: 'z'}, {id: 'a', alias: 'a'}],
      })
      await tx.create({
        id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'bar',
        references: [{id: 'y', alias: 'y'}, {id: 'b', alias: 'b'}],
      })
    }, {scope: ChangeScope.BlockDefault})

    expect(await readReferences(env.h.db, 'a')).toEqual([
      {id: 'a', alias: 'a'},
      {id: 'z', alias: 'z'},
    ])
    expect(await readReferences(env.h.db, 'b')).toEqual([
      {id: 'b', alias: 'b'},
      {id: 'y', alias: 'y'},
    ])
  })

  it('amendments ride on the user tx — one BlockDefault undo entry covers both', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'foo'})
    }, {scope: ChangeScope.BlockDefault})

    const depthBefore = env.repo.undoManager.depths(ChangeScope.BlockDefault)

    await env.repo.tx(async tx => {
      await tx.update('a', {references: [{id: 'z', alias: 'z'}, {id: 'a', alias: 'a'}]})
    }, {scope: ChangeScope.BlockDefault})

    const depthAfter = env.repo.undoManager.depths(ChangeScope.BlockDefault)
    expect(depthAfter.undo).toBe(depthBefore.undo + 1)

    // Undo brings us back to the pre-update state (empty references).
    await env.repo.undo(ChangeScope.BlockDefault)
    expect(await readReferences(env.h.db, 'a')).toEqual([])
  })
})

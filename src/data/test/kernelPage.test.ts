// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, seedType } from '@/data/api'
import { PAGE_TYPE } from '@/data/blockTypes'
import { aliasesProp, typesProp } from '@/data/properties'
import { typeSeedsFacet } from '@/data/facets'
import {
  getOrCreateKernelPage,
  kernelPageBlockId,
} from '@/data/kernelPage'
import { Repo } from '@/data/repo'
import { createTestRepo } from '@/data/test/createTestRepo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'

const WS = 'ws-kernel-page'
const FOO_PAGE_TYPE = 'panel:foo'
const FOO_PAGE_NS = '6f9b1f4c-2a0a-4f6e-9e1c-1c9f5b0d2e90'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  // Install a runtime that registers the synthetic marker type alongside
  // kernel data so addTypeInTx will accept it.
  const { repo } = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
    extensions: [
      typeSeedsFacet.of(seedType({seedKey: 'test/type/panel-foo', revision: 1, id: FOO_PAGE_TYPE, label: 'Foo'}), {source: 'test'}),
    ],
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

describe('getOrCreateKernelPage', () => {
  it('creates a deterministic page tagged with PAGE_TYPE plus the marker type', async () => {
    const page = await getOrCreateKernelPage(env.repo, WS, {
      namespace: FOO_PAGE_NS,
      alias: 'Foo',
      markerType: FOO_PAGE_TYPE,
    })

    expect(page.id).toBe(kernelPageBlockId(WS, FOO_PAGE_NS))
    expect(page.peek()?.content).toBe('Foo')
    expect(page.peekProperty(aliasesProp)).toEqual(['Foo'])
    expect(page.peekProperty(typesProp)).toEqual([PAGE_TYPE, FOO_PAGE_TYPE])
  })

  it('restores a soft-deleted kernel page with both type tags reinstated', async () => {
    const page = await getOrCreateKernelPage(env.repo, WS, {
      namespace: FOO_PAGE_NS,
      alias: 'Foo',
      markerType: FOO_PAGE_TYPE,
    })
    await env.repo.tx(async tx => { await tx.delete(page.id) }, {scope: ChangeScope.BlockDefault})

    const restored = await getOrCreateKernelPage(env.repo, WS, {
      namespace: FOO_PAGE_NS,
      alias: 'Foo',
      markerType: FOO_PAGE_TYPE,
    })

    expect(restored.peek()?.deleted).toBe(false)
    expect(restored.peekProperty(typesProp)).toEqual([PAGE_TYPE, FOO_PAGE_TYPE])
    expect(restored.peekProperty(aliasesProp)).toEqual(['Foo'])
  })

  it('restores a tombstone whose stored alias bag was squatted while it was dead (issue #378)', async () => {
    // Mirrors the `createOrRestoreTargetBlock` regression test (PR #371,
    // referencesProcessor.test.ts: "restores a merged-away daily seat
    // whose tombstone carries a stale alias claim"): the tombstoned row's
    // stored `aliases` bag can hold an entry that now belongs to a
    // DIFFERENT live block. Raw `tx.restore(id, {content: spec.alias})`
    // (no `properties` patch) re-inserts that stale bag as-is through
    // `blocks_alias_update` on the `deleted` flip, trips
    // `block_aliases_workspace_alias_unique` against the squatter, and
    // rolls back the WHOLE tx — the kernel page stays a tombstone forever
    // (issue #378). The bag here carries an EXTRA alias beyond the
    // canonical `spec.alias` (e.g. a stray manual edit) — not a collision
    // on `spec.alias` itself, which is a separate, undecided case (see
    // the issue).
    const page = await getOrCreateKernelPage(env.repo, WS, {
      namespace: FOO_PAGE_NS,
      alias: 'Foo',
      markerType: FOO_PAGE_TYPE,
    })
    await env.repo.tx(async tx => {
      await tx.setProperty(page.id, aliasesProp, ['Foo', 'stale-extra'])
      await tx.delete(page.id)
    }, {scope: ChangeScope.BlockDefault})

    // A different live block claims the freed stale alias while the
    // kernel page is dead.
    await env.repo.tx(async tx => {
      await tx.create({id: 'squatter', workspaceId: WS, parentId: null, orderKey: 'z0', content: 'Squatter'})
      await tx.setProperty('squatter', aliasesProp, ['stale-extra'])
    }, {scope: ChangeScope.BlockDefault})

    const restored = await getOrCreateKernelPage(env.repo, WS, {
      namespace: FOO_PAGE_NS,
      alias: 'Foo',
      markerType: FOO_PAGE_TYPE,
    })

    expect(restored.id).toBe(page.id)
    expect(restored.peek()?.deleted).toBe(false)
    expect(restored.peekProperty(typesProp)).toEqual([PAGE_TYPE, FOO_PAGE_TYPE])
    // The restored page reclaims its canonical alias; the stale extra
    // is NOT resurrected — it stays with the squatter.
    expect(restored.peekProperty(aliasesProp)).toEqual(['Foo'])
    expect(env.repo.block('squatter').peekProperty(aliasesProp)).toEqual(['stale-extra'])
  })
})

// @vitest-environment node
/**
 * §9 orphan-definition synthesis on an END-TO-END ENCRYPTED workspace.
 *
 * Its own file because the setup is: a mode pin of `e2ee` is only writable
 * against a real localStorage, and the workspace needs `K_id` in the key store.
 * Both are process-wide state the plaintext file must not inherit.
 *
 * What is actually under test is one property — a synthesized definition's id
 * must not be a hash of the property NAME that an untrusted server can
 * recompute — plus the refusals that keep the pass from reaching for the public
 * namespace when it cannot establish the private one.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { v5 as uuidv5 } from 'uuid'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { propertiesPageBlockId } from '@/data/propertiesPage'
import { deriveContentKeyHmac } from '@/sync/crypto/contentKey'
import { deriveWorkspaceIdNamespace } from '@/sync/crypto/derivedIdNamespace'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { setModePin } from '@/sync/keys/modePin'
import {
  applyPropertyDefinitionSynthesis,
  planPropertyDefinitionSynthesis,
  resolveSynthesisNamespace,
  synthesizedPropertyDefinitionBlockId,
} from './propertyDefinitionSynthesis'

const WS = 'ws-synthesis-e2ee'
const USER = 'user-e2ee'
/** The namespace a plaintext workspace uses — spelled out, because the point of
 *  the central assertion is that an encrypted workspace's ids are NOT these. */
const PLAINTEXT_NS = 'b1d6b0c7-6a2a-4c1e-9a19-2f0f7b6b3c41'

let sharedDb: TestDb
let repo: Repo

/** `setModePin` refuses to pin `e2ee` without a durable localStorage — by
 *  design, since the pin is the only local authority on the mode. Node has
 *  none, so give it one; the store is per-test, so a pin never leaks across. */
const stubLocalStorage = () => {
  const entries = new Map<string, string>()
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, String(value)) },
    removeItem: (key: string) => { entries.delete(key) },
  }
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('window', {localStorage: storage})
}

/** Put `K_id` where the pass looks for it: the same per-device store an unlock
 *  flow writes, holding the same subkey the asset path uses. */
const storeContentKey = async (fill = 7) => {
  const contentKeyHmac = await deriveContentKeyHmac(new Uint8Array(32).fill(fill))
  const wk = await crypto.subtle.generateKey(
    {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt'])
  await getWorkspaceKeyStore().put(USER, WS, {wk, contentKeyHmac})
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(async () => {
  vi.unstubAllGlobals()
  await getWorkspaceKeyStore().delete(USER, WS)
})

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  stubLocalStorage()
  repo = createTestRepo({db: sharedDb.db, user: {id: USER}}).repo
  repo.setActiveWorkspaceId(WS)
  await sharedDb.db.execute(
    `INSERT OR REPLACE INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary,
        properties_migration)
     VALUES (?, 'ws', ?, 1, 1, 'e2ee', 'canary', 'cell')`,
    [WS, USER])
  setModePin(USER, WS, 'e2ee')
})

/** A cell written WITHOUT the tx layer — the only way to store a key no schema
 *  declares (`tx.setProperty` resolves the name and would refuse). */
const rawCell = async (id: string, properties: Record<string, unknown>) => {
  await repo.tx(async tx => {
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: `k-${id}`, content: id})
  }, {scope: ChangeScope.BlockDefault, description: 'seed'})
  await sharedDb.db.execute(
    `UPDATE blocks SET properties_json = ? WHERE id = ?`,
    [JSON.stringify(properties), id])
}

const readyNamespace = async () => {
  const resolved = await resolveSynthesisNamespace(repo, WS)
  if (resolved.kind !== 'ready') throw new Error(`refused: ${resolved.reason}`)
  return resolved.namespace
}

describe('resolveSynthesisNamespace on an e2ee workspace', () => {
  it('does not refuse — an unlocked encrypted workspace can synthesize', async () => {
    await storeContentKey()
    expect((await resolveSynthesisNamespace(repo, WS)).kind).toBe('ready')
  })

  // Recomputed INDEPENDENTLY, from the key bytes and the label spelled out here
  // — not by asking `resolveSynthesisNamespace` what it thinks. Every other
  // assertion in this file takes its expected id from the code under test, so
  // without this one the label could be revised, the derivation could move to a
  // different slice of the MAC, or a per-process salt could creep in, and the
  // whole suite would stay green while every device minted a different id.
  it('is exactly HMAC(K_id, the versioned label) — a pure function of key material',
    async () => {
      await storeContentKey(7)
      expect(await readyNamespace()).toBe(await deriveWorkspaceIdNamespace(
        await deriveContentKeyHmac(new Uint8Array(32).fill(7)),
        'km/property-definition-ns/v1'))
    })

  it('derives a namespace from the workspace key, not the public constant', async () => {
    await storeContentKey()
    expect(await readyNamespace()).not.toBe(PLAINTEXT_NS)
  })

  it('follows the workspace key — a different K_id gives a different namespace', async () => {
    await storeContentKey(7)
    const first = await readyNamespace()
    await storeContentKey(9)
    expect(await readyNamespace()).not.toBe(first)
  })

  it('refuses when the device holds no content key, rather than falling back to the public one',
    async () => {
      // The whole guard: a fallback here would publish name-derived ids for the
      // one workspace kind that must never have them. `resolveWorkspaceEntry`
      // already locks a K_id-less e2ee record, so reaching this is a bug — and a
      // refusal is how a bug stays a bug instead of becoming a leak.
      const resolved = await resolveSynthesisNamespace(repo, WS)
      expect(resolved).toEqual({kind: 'refused', reason: expect.stringMatching(/no content key/)})
    })

  it('refuses when the pin says e2ee but the row reads plaintext', async () => {
    await storeContentKey()
    await sharedDb.db.execute(
      `UPDATE workspaces SET encryption_mode = 'none' WHERE id = ?`, [WS])

    expect(await resolveSynthesisNamespace(repo, WS))
      .toEqual({kind: 'refused', reason: expect.stringMatching(/pinned as e2ee/)})
  })
})

describe('applyPropertyDefinitionSynthesis on an e2ee workspace', () => {
  it('mints the definition at an id the public formula does not predict', async () => {
    await storeContentKey()
    await rawCell('b1', {'demo:orphan': 'hello'})

    const result = await applyPropertyDefinitionSynthesis(
      repo, await planPropertyDefinitionSynthesis(repo, WS))

    expect(result.created).toBe(1)
    const id = synthesizedPropertyDefinitionBlockId(await readyNamespace(), WS, 'demo:orphan')
    expect(repo.block(id).peek()?.properties['property-schema:name']).toBe('demo:orphan')
    // The assertion the whole change exists for: a server that hashes a guessed
    // property name under the public namespace finds no row.
    expect(id).not.toBe(uuidv5(`${WS}:demo%3Aorphan`, PLAINTEXT_NS))
    expect(repo.block(uuidv5(`${WS}:demo%3Aorphan`, PLAINTEXT_NS)).peek()).toBeUndefined()
  })

  it('converges on re-run — the derived namespace is stable for the same key', async () => {
    await storeContentKey()
    await rawCell('b1', {'demo:orphan': 'hello'})
    // The SAME plan twice, deliberately. Re-planning would find no candidate at
    // all and return early, so `created: 0` would hold for a namespace that
    // changed on every call — which is the failure this test is named for. Fed
    // the original plan, the second run has to re-derive the id and find its own
    // block there, which is what `converged: 1` means.
    const plan = await planPropertyDefinitionSynthesis(repo, WS)
    expect(await applyPropertyDefinitionSynthesis(repo, plan))
      .toEqual({created: 1, converged: 0, skipped: []})

    const again = await applyPropertyDefinitionSynthesis(repo, plan)

    expect(again).toEqual({created: 0, converged: 1, skipped: []})
    const definitions = await repo.db.getAll<{n: number}>(
      `SELECT COUNT(*) AS n FROM blocks b JOIN block_types t ON t.block_id = b.id
        WHERE t.type = 'property-schema' AND b.workspace_id = ? AND b.deleted = 0
          AND json_extract(b.properties_json, '$."property-schema:name"') = 'demo:orphan'`,
      [WS])
    expect(definitions[0]!.n).toBe(1)
  })

  it('refuses to WRITE once the content key goes missing mid-gesture', async () => {
    await storeContentKey()
    await rawCell('b1', {'demo:orphan': 'hello'})
    const plan = await planPropertyDefinitionSynthesis(repo, WS)
    await getWorkspaceKeyStore().delete(USER, WS)

    await expect(applyPropertyDefinitionSynthesis(repo, plan))
      .rejects.toThrow(/no content key/)
    // And it refused BEFORE the Properties-page bootstrap, which commits its own
    // transaction — the in-transaction re-ask alone would leave that page behind.
    // Position, not presence, is what this pins.
    expect(await repo.db.getAll(
      'SELECT id FROM blocks WHERE id = ?', [propertiesPageBlockId(WS)])).toHaveLength(0)
  })
})

/**
 * The id formulas every derived block in this app is already sitting at.
 *
 * This file deliberately restates each formula as a literal, which is normally
 * a test smell — here it is the whole point. A derived id is not an
 * implementation detail: live rows ARE at these ids, on this device and on
 * every other. Change a namespace constant, a delimiter, or the order of two
 * interpolated fields and the kind silently re-points at fresh ids, every row
 * already written becomes unreachable, and nothing fails until a user notices
 * their pages are gone.
 *
 * So the assertions below are an independent oracle, not a mirror: they hash
 * the namespace and key shape as literal text, with no reference to the
 * constants the implementation uses. A refactor that routes a helper through
 * `derivedBlockId` passes only if it produces the same bytes it did before.
 *
 * Adding a helper here is cheap and worth it. Changing an expectation is a
 * data migration — the number to change is not this one.
 */

import { describe, expect, it } from 'vitest'
import { v5 as uuidv5 } from 'uuid'

import { derivedBlockId, workspaceDerivedBlockId } from './derivedIds'
import { kernelPageBlockId } from './kernelPage'
import { propertyDefinitionBlockId, typeDefinitionBlockId } from './definitionSeeds'
import { computeAliasSeatId } from './targets'
import { userPageBlockId } from './stateBlocks'
import { pluginBlockId } from '@/extensions/pluginIds'
import { dailyNoteBlockId, journalBlockId } from '@/plugins/daily-notes'
import { roamBlockId } from '@/plugins/roam-import/ids'
import { mediaBlockId } from '@/plugins/attachments/mediaCapture'
import { shortcutsBlockId, journalShortcutBlockId } from '@/plugins/left-sidebar/shortcuts'

// Arbitrary but fixed — the point is that the same inputs always hash the same
// way, so any stable values do. Real-shaped where the shape matters (a uuid
// workspace id, an ISO date, a seed key that passes its grammar check).
const WS = '3f2b7c10-9d4e-4a61-8c2f-15b0e7a94d33'
const OTHER_WS = 'c0ffee00-1111-4222-8333-444455556666'

describe('derivedBlockId', () => {
  it('is uuid v5 of the key under the namespace', () => {
    const namespace = 'd4a1f0c8-2b93-4e57-9f6a-8c1d2e3b4a50'
    expect(derivedBlockId({namespace, key: 'some-key'}))
      .toBe(uuidv5('some-key', namespace))
  })

  it('distinguishes keys, namespaces, and the boundary between them', () => {
    const nsA = 'd4a1f0c8-2b93-4e57-9f6a-8c1d2e3b4a50'
    const nsB = 'e5b2a1d9-3c04-4f68-a07b-9d2e3f4c5b61'
    expect(derivedBlockId({namespace: nsA, key: 'a'}))
      .not.toBe(derivedBlockId({namespace: nsB, key: 'a'}))
    expect(derivedBlockId({namespace: nsA, key: 'a'}))
      .not.toBe(derivedBlockId({namespace: nsA, key: 'b'}))
  })

  it('workspaceDerivedBlockId joins with a colon', () => {
    const namespace = 'd4a1f0c8-2b93-4e57-9f6a-8c1d2e3b4a50'
    expect(workspaceDerivedBlockId(namespace, WS, 'thing'))
      .toBe(uuidv5(`${WS}:thing`, namespace))
  })
})

/**
 * Every live formula, pinned. One `it` per kind so a break names the kind
 * whose rows would be orphaned rather than a line number.
 */
describe('the ids live rows are already at', () => {
  it('plugin-owned blocks (public API — extension authors have written rows here)', () => {
    const pluginNs = '0d4f1c2e-7e9a-4f4d-a4f1-2c0a3a6e7f01'
    expect(pluginBlockId(WS, pluginNs, 'library-root'))
      .toBe(uuidv5(`${WS}:library-root`, pluginNs))
  })

  it('kernel pages (Properties, Types, Assets)', () => {
    const pageNs = 'b6e4d9a1-2f47-4c3e-9a0d-7c1e8f5b2a36'
    expect(kernelPageBlockId(WS, pageNs)).toBe(uuidv5(WS, pageNs))
  })

  it('the Journal page', () => {
    expect(journalBlockId(WS)).toBe(uuidv5(WS, 'a304a5da-807a-4c20-8af3-53a033aa9df8'))
  })

  it('daily notes', () => {
    expect(dailyNoteBlockId(WS, '2026-07-24'))
      .toBe(uuidv5(`${WS}:2026-07-24`, '53421e08-2f31-42f8-b73a-43830bb718f1'))
  })

  it('property definition seeds', () => {
    const seedKey = 'system:kernel-data/property/show-properties'
    expect(propertyDefinitionBlockId(WS, seedKey))
      .toBe(uuidv5(`${WS}:${seedKey}`, '737c2e9d-f3e9-4c99-94ef-e1cbec920e30'))
  })

  it('type definition seeds (same namespace as property seeds; disjoint grammars)', () => {
    const seedKey = 'system:kernel-data/type/page'
    expect(typeDefinitionBlockId(WS, seedKey))
      .toBe(uuidv5(`${WS}:${seedKey}`, '737c2e9d-f3e9-4c99-94ef-e1cbec920e30'))
  })

  it('alias seats, at every probe slot', () => {
    const aliasNs = 'a3c8a8c0-7c3a-4d2c-bc4f-1f6c2c6a7d11'
    expect(computeAliasSeatId('Some Page', WS))
      .toBe(uuidv5(`${WS}:Some Page:0`, aliasNs))
    expect(computeAliasSeatId('Some Page', WS, 3))
      .toBe(uuidv5(`${WS}:Some Page:3`, aliasNs))
  })

  it('Roam-imported blocks', () => {
    expect(roamBlockId(WS, 'abc123'))
      .toBe(uuidv5(`${WS}:roam:abc123`, 'b8d6f1c2-7e9a-4f4d-a4f1-2c0a3a6e7f01'))
  })

  it('media asset blocks', () => {
    expect(mediaBlockId(WS, 'sha256-deadbeef'))
      .toBe(uuidv5(`${WS}:sha256-deadbeef`, 'a1f4c7e2-9b3d-4e6a-8c5f-2d0b1e7a4c93'))
  })

  it('sidebar shortcuts (keyed on a block id, not a workspace)', () => {
    const userBlock = '7a1c3e59-0b2d-4f68-9a3c-1e5d7b9f2a40'
    const shortcuts = shortcutsBlockId(userBlock)
    expect(shortcuts).toBe(uuidv5(userBlock, 'c1d7a2e3-4b6f-4a8e-9c5d-2f3b6e8a1c47'))
    expect(journalShortcutBlockId(shortcuts))
      .toBe(uuidv5(shortcuts, 'b2a4f7c9-3d5e-4f1b-8a2c-9e7b6d4f3a51'))
  })

  it('user pages', () => {
    const userId = '2c9f8a71-4d3e-4b05-8e17-6a0f9c3d5b28'
    expect(userPageBlockId(WS, userId))
      .toBe(uuidv5(`${WS}:${userId}`, '99b1b4e5-6f58-4fd2-9089-dc3b358dd4df'))
  })
})

/**
 * Workspace scoping is the invariant most likely to be dropped by a refactor
 * that "simplifies" a key, and it fails quietly: the two workspaces don't
 * collide until both exist on one device, and then one finds its block already
 * occupied by the other's.
 */
describe('workspace scoping', () => {
  it('keeps every workspace-scoped kind distinct across workspaces', () => {
    expect(journalBlockId(WS)).not.toBe(journalBlockId(OTHER_WS))
    expect(dailyNoteBlockId(WS, '2026-07-24'))
      .not.toBe(dailyNoteBlockId(OTHER_WS, '2026-07-24'))
    expect(roamBlockId(WS, 'abc123')).not.toBe(roamBlockId(OTHER_WS, 'abc123'))
    expect(mediaBlockId(WS, 'sha256-deadbeef'))
      .not.toBe(mediaBlockId(OTHER_WS, 'sha256-deadbeef'))
    expect(computeAliasSeatId('Some Page', WS))
      .not.toBe(computeAliasSeatId('Some Page', OTHER_WS))
    expect(propertyDefinitionBlockId(WS, 'system:kernel-data/property/show-properties'))
      .not.toBe(propertyDefinitionBlockId(OTHER_WS, 'system:kernel-data/property/show-properties'))
  })
})

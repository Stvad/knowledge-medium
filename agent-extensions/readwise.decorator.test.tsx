// @vitest-environment happy-dom
//
// The reviewed mark is otherwise invisible — nothing else in the app reads
// `readwise:reviewed` — so these render the REAL decorator off the extension's
// contribution list against a REAL block and assert on node values: is the
// content dimmed, is the undo control there, and does clicking it write.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ChangeScope } from '@/data/api/index.js'
import type { Repo } from '@/data/repo.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb.js'
import { createTestRepo } from '@/data/test/createTestRepo.js'
import {
  blockContentDecoratorsFacet,
  type BlockResolveContext,
} from '@/extensions/blockInteraction.js'
import type { AppExtension } from '@/facets/facet.js'
import { getBlockTypes } from '@/data/properties.js'
import { dailyNotesDataExtension } from '@/plugins/daily-notes/dataExtension.js'
import type { BlockRenderer } from '@/types.js'

import readwiseContributions from './readwise.tsx'

const HIGHLIGHT_TYPE = 'readwise-highlight'
const REVIEWED_PROP = 'readwise:reviewed'
const WS = 'ws-1'

const readwiseDataAndUi = readwiseContributions
  // `'facet' in c` also drops the nested AppExtension arrays (the dialog host),
  // which is what these suites want: they exclude every app mount anyway.
  .filter(c => 'facet' in (c as object)
    && !['core.app-mounts', 'core.app-effects'].includes((c as any).facet.id)) as unknown as AppExtension[]

let sharedDb: TestDb

const setup = () => {
  const { repo } = createTestRepo({
    db: sharedDb.db,
    extensions: [dailyNotesDataExtension, ...readwiseDataAndUi],
  })
  return { repo, runtime: repo.facetRuntime! }
}

const seedHighlight = async (repo: Repo, reviewed: boolean) => {
  const snapshot = repo.snapshotTypeRegistries()
  await repo.tx(async tx => {
    await tx.create({
      id: 'hl', workspaceId: WS, parentId: null, orderKey: 'a0',
      content: 'the highlighted sentence',
    })
    await repo.addTypeInTx(tx, 'hl', HIGHLIGHT_TYPE, { [REVIEWED_PROP]: reviewed }, snapshot)
  }, { scope: ChangeScope.BlockDefault, description: 'seed' })
  const block = repo.block('hl')
  await block.load()
  return block
}

/** The inner renderer the decorator wraps — stands in for the block's real body. */
const Inner: BlockRenderer = ({ block }) => <span>{block.peek()?.content}</span>

/** Resolve the decorated renderer the way the app does — the resolve context's
 *  `types` come from the block itself, so the contribution's own gate is part of
 *  what's under test rather than being handed the answer. */
const renderDecorated = async (repo: Repo, runtime: ReturnType<typeof setup>['runtime']) => {
  const block = repo.block('hl')
  const decorate = runtime.read(blockContentDecoratorsFacet)
  const Decorated = decorate(
    // Only `types` is read by the contribution under test; the rest of the
    // resolve context would need a full render tree to build honestly.
    { types: [...getBlockTypes(block.peek()!)] } as unknown as BlockResolveContext,
    Inner,
  )
  await act(async () => { render(<Decorated block={block}/>) })
  return block
}

const undoControl = () => screen.queryByRole('button', { name: 'Mark highlight unreviewed' })
const contentEl = () => screen.getByText('the highlighted sentence')

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })
afterEach(() => { cleanup() })

describe('reviewed highlight decoration', () => {
  it('leaves an unreviewed highlight undecorated', async () => {
    const { repo, runtime } = setup()
    await seedHighlight(repo, false)

    await renderDecorated(repo, runtime)

    expect(undoControl()).toBeNull()
    expect(contentEl().closest('div')?.className ?? '').not.toContain('text-muted-foreground')
  })

  it('dims a reviewed highlight and offers an undo control', async () => {
    const { repo, runtime } = setup()
    await seedHighlight(repo, true)

    await renderDecorated(repo, runtime)

    expect(undoControl()).not.toBeNull()
    expect(contentEl().closest('div')!.className).toContain('text-muted-foreground')
  })

  it('un-reviews the block when the control is clicked', async () => {
    const { repo, runtime } = setup()
    await seedHighlight(repo, true)
    const block = await renderDecorated(repo, runtime)

    await act(async () => { fireEvent.click(undoControl()!) })

    // The handler fires the write and returns; poll the outcome rather than
    // assuming it lands inside `act`.
    await vi.waitFor(() => {
      expect(block.peek()!.properties[REVIEWED_PROP]).toBe(false)
    })
    // …and the decoration goes away with it, without a remount.
    await vi.waitFor(() => { expect(undoControl()).toBeNull() })
  })

  it('picks up a reviewed flip that happens while mounted', async () => {
    const { repo, runtime } = setup()
    const seeded = await seedHighlight(repo, false)
    await renderDecorated(repo, runtime)
    expect(undoControl()).toBeNull()

    // What the latch keypress does — or a flip arriving from another device.
    await act(async () => {
      await seeded.repo.tx(async tx => {
        const row = await tx.get('hl')
        await tx.update('hl', { properties: { ...row!.properties, [REVIEWED_PROP]: true } })
      }, { scope: ChangeScope.BlockDefault, description: 'mark reviewed' })
    })

    expect(undoControl()).not.toBeNull()
  })

  it('drops the decoration if the block stops being a highlight while mounted', async () => {
    // The contribution gate only re-runs when the decorator set is re-resolved,
    // so the component re-checks the type itself. Without that check a block
    // that loses the highlight type keeps the reviewed chrome.
    const { repo, runtime } = setup()
    await seedHighlight(repo, true)
    await renderDecorated(repo, runtime)
    expect(undoControl()).not.toBeNull()

    await act(async () => {
      await repo.tx(async tx => {
        await repo.removeTypeInTx(tx, 'hl', HIGHLIGHT_TYPE)
      }, { scope: ChangeScope.BlockDefault, description: 'untag' })
    })

    await vi.waitFor(() => { expect(undoControl()).toBeNull() })
  })

  it('renders through a malformed reviewed value instead of throwing', async () => {
    // The strict codec throws on a non-boolean, and this decorator is attached to
    // every highlight — so decoding strictly would take out the whole block's
    // render for a `"true"` left by a raw import / sync / bridge write.
    const { repo, runtime } = setup()
    await seedHighlight(repo, true)
    await repo.tx(async tx => {
      const row = await tx.get('hl')
      await tx.update('hl', { properties: { ...row!.properties, [REVIEWED_PROP]: 'true' } })
    }, { scope: ChangeScope.BlockDefault, description: 'corrupt reviewed' })
    await repo.block('hl').load()

    await renderDecorated(repo, runtime)

    // Degrades to undecorated; the block itself still renders.
    expect(contentEl()).not.toBeNull()
    expect(undoControl()).toBeNull()
  })

  it('does not decorate a non-highlight block', async () => {
    const { repo, runtime } = setup()
    await repo.tx(async tx => {
      await tx.create({
        id: 'hl', workspaceId: WS, parentId: null, orderKey: 'a0',
        content: 'the highlighted sentence',
      })
    }, { scope: ChangeScope.BlockDefault, description: 'seed plain' })
    await repo.block('hl').load()

    await renderDecorated(repo, runtime)

    expect(undoControl()).toBeNull()
  })
})

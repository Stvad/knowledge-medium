// @vitest-environment happy-dom
/** Contract of the title date-nav arrows.
 *
 *  The whole reason they left the app header is panel scoping, so that is what
 *  this pins end-to-end against a real repo + layout session: clicking prev on
 *  a note rendered in panel B moves PANEL B, even while panel A is the active
 *  one (the header pair went through `resolveGlobalCommandTarget` and would
 *  have moved A). The rest covers who gets arrows at all — only a daily note,
 *  only as the focal block of its panel.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { BlockContextProvider } from '@/context/block'
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import { activePanelIdProp, aliasesProp, topLevelBlockIdProp } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { BlockResolveContext } from '@/extensions/blockInteraction'
import type { BlockRendererProps } from '@/types'
import { __resetLayoutSessionIdForTesting } from '@/utils/layoutSessionId'
import { insertPanelRow } from '@/utils/panelLayoutProjection'
import { aliasDataExtension } from '@/plugins/alias/dataExtension.js'
import { dailyNoteDateProp } from '../schema.ts'
import { dateNavDecoratorContribution } from '../DateNavDecorator.tsx'
import {
  dailyNoteBlockId,
  dailyNotesDataExtension,
  getOrCreateDailyNote,
} from '../index.ts'

const WS = 'ws-date-nav'
const USER = {id: 'user-1', name: 'Alice'}
const TODAY = '2026-05-13'
const YESTERDAY = '2026-05-12'
const TOMORROW = '2026-05-14'

const focalContext = (overrides: Partial<BlockResolveContext> = {}) =>
  ({isTopLevel: true, blockContext: {}, ...overrides}) as BlockResolveContext

const Inner = ({block}: BlockRendererProps) => <div data-testid="inner">{block.id}</div>

const decorate = dateNavDecoratorContribution(focalContext())
if (!decorate) throw new Error('date-nav decorator opted out for a focal render')
const Decorated = decorate(Inner)

const InPanel = ({panelId, children}: {panelId: string; children: ReactNode}) => (
  <BlockContextProvider initialValue={{panelId}}>{children}</BlockContextProvider>
)

interface Harness {
  repo: Repo
  layoutSession: Block
}

let sharedDb: TestDb
let env: Harness

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  __resetLayoutSessionIdForTesting()
  await resetTestDb(sharedDb.db)
  const {repo} = createTestRepo({
    db: sharedDb.db,
    user: USER,
    // `aliasDataExtension` too: a day that had to yield its ISO name is one of
    // the cases here, and the processor that reconciles content against
    // aliases is what makes that state behave the way it does in the app.
    extensions: [dailyNotesDataExtension, aliasDataExtension],
  })
  repo.setActiveWorkspaceId(WS)
  const uiState = await getUIStateBlock(repo, WS, USER, {})
  env = {repo, layoutSession: await getLayoutSessionBlock(uiState, repo.activeLayoutSessionId)}
})

afterEach(() => {
  cleanup()
  env.repo.setActiveWorkspaceId(null)
})

const createRootBlock = async (id: string, content: string) => {
  await env.repo.tx(async tx => {
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'm0', content})
  }, {scope: ChangeScope.BlockDefault})
  const block = env.repo.block(id)
  await block.load()
  return block
}

const topLevelOf = async (panelId: string) => {
  const panel = env.repo.block(panelId)
  await panel.load()
  return panel.peekProperty(topLevelBlockIdProp)
}

describe('date-nav arrows', () => {
  // Real repo + layout + render; measured ~1.5s, and the gate's per-core
  // parallelism stretches that several times over.
  it('navigates its OWN panel, not the active one', async () => {
    const note = await getOrCreateDailyNote(env.repo, WS, TODAY)
    await note.load()
    await createRootBlock('other-block', 'Other')
    const notePanelId = await insertPanelRow(env.repo, env.layoutSession, note.id)
    const activePanelId = await insertPanelRow(env.repo, env.layoutSession, 'other-block')
    await env.layoutSession.set(activePanelIdProp, activePanelId)

    render(<InPanel panelId={notePanelId}><Decorated block={note}/></InPanel>)
    ;(await screen.findByRole('button', {name: 'Open previous daily note'})).click()

    await waitFor(async () => {
      expect(await topLevelOf(notePanelId)).toBe(dailyNoteBlockId(WS, YESTERDAY))
    })
    // Yesterday had no note until the click — the arrow creates it.
    expect(await env.repo.exists(dailyNoteBlockId(WS, YESTERDAY))).toBe(true)
    // The panel that was active never moved.
    expect(await topLevelOf(activePanelId)).toBe('other-block')
  }, 20_000)

  it('still knows its date when another page owns the ISO name', async () => {
    // A day whose ISO name is already claimed yields it rather than fighting
    // for it — claiming it would abort the transaction the page is created in.
    // Reading identity out of the alias list then says this is not a daily
    // note at all: no arrows, and the global prev/next stepping from TODAY
    // instead of the day on screen.
    await env.repo.tx(async tx => {
      await tx.create({id: 'rival', workspaceId: WS, parentId: null, orderKey: 'r0', content: 'Mine'})
      await tx.setProperty('rival', aliasesProp, [TODAY])
    }, {scope: ChangeScope.BlockDefault})
    const note = await getOrCreateDailyNote(env.repo, WS, TODAY)
    await note.load()
    // The precondition this whole test is about — without it the case never
    // reaches the code under test and the assertion below passes for free.
    expect(note.peekProperty(aliasesProp) ?? []).not.toContain(TODAY)
    const panelId = await insertPanelRow(env.repo, env.layoutSession, note.id)

    render(<InPanel panelId={panelId}><Decorated block={note}/></InPanel>)
    ;(await screen.findByRole('button', {name: 'Open previous daily note'})).click()

    await waitFor(async () => {
      expect(await topLevelOf(panelId)).toBe(dailyNoteBlockId(WS, YESTERDAY))
    })
  }, 20_000)

  it('ignores a date cell that disagrees with the page it is on', async () => {
    // `daily-note:date` is an ordinary editable cell — the properties panel
    // offers it — and nothing repairs it: initial values are written
    // only-if-empty and `needsRepair` never looks at the date. One wrong
    // keystroke would otherwise redirect this day's arrows permanently, while
    // the block id and both aliases still say which day it is.
    const note = await getOrCreateDailyNote(env.repo, WS, TODAY)
    await note.load()
    await env.repo.tx(tx => tx.setProperty(
      note.id, dailyNoteDateProp, new Date('1999-01-01T00:00:00Z'),
    ), {scope: ChangeScope.BlockDefault})
    const panelId = await insertPanelRow(env.repo, env.layoutSession, note.id)

    render(<InPanel panelId={panelId}><Decorated block={note}/></InPanel>)
    ;(await screen.findByRole('button', {name: 'Open previous daily note'})).click()

    await waitFor(async () => {
      expect(await topLevelOf(panelId)).toBe(dailyNoteBlockId(WS, YESTERDAY))
    })
  }, 20_000)

  it('steps forward a day from the note it is attached to', async () => {
    const note = await getOrCreateDailyNote(env.repo, WS, TODAY)
    await note.load()
    const panelId = await insertPanelRow(env.repo, env.layoutSession, note.id)

    render(<InPanel panelId={panelId}><Decorated block={note}/></InPanel>)
    ;(await screen.findByRole('button', {name: 'Open next daily note'})).click()

    await waitFor(async () => {
      expect(await topLevelOf(panelId)).toBe(dailyNoteBlockId(WS, TOMORROW))
    })
  }, 20_000)

  /** Render `block` after PROVING the arrows appear for a real daily note in
   *  the same harness — otherwise "no arrows" passes trivially on the first
   *  render, before the alias read has resolved, and stays green with the gate
   *  deleted. */
  const expectUndecorated = async (panelId: string, block: Block) => {
    const note = await getOrCreateDailyNote(env.repo, WS, TODAY)
    await note.load()
    render(<InPanel panelId={panelId}><Decorated block={note}/></InPanel>)
    await screen.findByRole('button', {name: 'Open previous daily note'})
    cleanup()

    render(<InPanel panelId={panelId}><Decorated block={block}/></InPanel>)
    await screen.findByTestId('inner')
    expect(screen.queryAllByRole('button')).toEqual([])
  }

  it('leaves a non-daily-note page undecorated', async () => {
    const panelId = await insertPanelRow(env.repo, env.layoutSession, 'plain-page')

    await expectUndecorated(panelId, await createRootBlock('plain-page', 'Plain'))
  }, 20_000)

  it('leaves a page whose alias only LOOKS like a date undecorated', async () => {
    // `2026-02-30` is date-SHAPED but not a calendar day, so the references
    // processor routes it to an ordinary alias target — a normal page, not a
    // daily note. A shape-only alias check hands that page the arrows, and
    // `addDaysIso` then reads it as March 2nd: "previous day" jumps FORWARD
    // to 2026-03-01.
    const panelId = await insertPanelRow(env.repo, env.layoutSession, 'alias-page')
    const aliasPage = await createRootBlock('alias-page', '2026-02-30')
    await aliasPage.set(aliasesProp, ['2026-02-30'])

    await expectUndecorated(panelId, aliasPage)
  }, 20_000)

  it('opts out on any surface that is not the panel body', () => {
    // An embed / backlink row / breadcrumb showing today's note is not the
    // thing the panel is zoomed into — arrows there would move a panel the
    // user is not looking at.
    expect(dateNavDecoratorContribution(focalContext({isTopLevel: false}))).toBeNull()
    expect(dateNavDecoratorContribution(
      focalContext({blockContext: {isNestedSurface: true}}),
    )).toBeNull()
  })

  it('memoizes the decorated renderer per inner renderer', () => {
    // A fresh component identity every render unmounts the content subtree
    // (and with it a live editor) on every parent re-render.
    expect(decorate(Inner)).toBe(decorate(Inner))
  })
})

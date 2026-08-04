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
import { activePanelIdProp, topLevelBlockIdProp } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { BlockResolveContext } from '@/extensions/blockInteraction'
import type { BlockRendererProps } from '@/types'
import { __resetLayoutSessionIdForTesting } from '@/utils/layoutSessionId'
import { insertPanelRow } from '@/utils/panelLayoutProjection'
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
    extensions: [dailyNotesDataExtension],
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

  it('leaves a non-daily-note page undecorated', async () => {
    const panelId = await insertPanelRow(env.repo, env.layoutSession, 'plain-page')

    // Fence: prove the arrows DO appear in this harness first, so the absence
    // below can't be "the alias read simply had not resolved yet".
    const note = await getOrCreateDailyNote(env.repo, WS, TODAY)
    await note.load()
    render(<InPanel panelId={panelId}><Decorated block={note}/></InPanel>)
    await screen.findByRole('button', {name: 'Open previous daily note'})
    cleanup()

    const plain = await createRootBlock('plain-page', 'Plain')
    render(<InPanel panelId={panelId}><Decorated block={plain}/></InPanel>)

    await screen.findByTestId('inner')
    expect(screen.queryAllByRole('button')).toEqual([])
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

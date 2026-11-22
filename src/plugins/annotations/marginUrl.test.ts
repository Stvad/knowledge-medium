// @vitest-environment node
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import type {User} from '@/data/api'
import {getLayoutSessionBlock, getUIStateBlock} from '@/data/stateBlocks'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {childrenOf, createTestRepo} from '@/data/test/createTestRepo'
import {Repo} from '@/data/repo'
import {panelViewModeProp} from '@/data/properties'
import {applyCurrentLayoutUrl, PanelLayoutProjection, panelBlockId} from '@/utils/panelLayoutProjection'
import {annotationsDataExtension} from './dataExtension'
import {annotationMarginOpenProp, annotationMarginShareProp} from './marginSchema'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  repo: Repo
  layoutId: string
}

let sharedDb: TestDb
let env: Harness
const projections: PanelLayoutProjection[] = []
afterEach(() => { for (const projection of projections.splice(0)) projection.dispose() })
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  const {repo} = createTestRepo({db: sharedDb.db, user: USER, extensions: [annotationsDataExtension]})
  repo.setActiveWorkspaceId(WS)
  const uiState = await getUIStateBlock(repo, WS, USER, {})
  const session = await getLayoutSessionBlock(uiState, 'layout-session-a')
  env = {repo, layoutId: session.id}
})

const rows = () => childrenOf(env.repo, env.layoutId)
const byBlock = async () => new Map((await rows()).map(row => [panelBlockId(row)!, row.id]))
const applyUrl = (hash: string, replaceHash?: (hash: string) => void) => applyCurrentLayoutUrl({
  repo: env.repo,
  workspaceId: WS,
  layoutSessionBlock: env.repo.block(env.layoutId),
  hash,
  replaceHash,
})

const startProjection = (initialHash: string) => {
  let currentHash = initialHash
  const pushes: string[] = []
  const projection = new PanelLayoutProjection({
    repo: env.repo,
    workspaceId: WS,
    layoutSessionBlock: env.repo.block(env.layoutId),
    getHash: () => currentHash,
    pushHash: hash => { pushes.push(hash); currentHash = hash },
    replaceHash: hash => { currentHash = hash },
    subscribeToUrl: () => () => {},
  })
  projections.push(projection)
  return {projection, pushes, hash: () => currentHash, setHash: (hash: string) => { currentHash = hash }}
}

describe('annotation margin URL projection', () => {
  it('applies ;comments in place and preserves other panel properties while toggling it off', async () => {
    await applyUrl('#ws-1/a;view=m')
    const rowA = (await byBlock()).get('a')!
    await env.repo.block(rowA).set(annotationMarginShareProp, 0.37)

    await applyUrl('#ws-1/a;comments;view=m')
    expect((await byBlock()).get('a')).toBe(rowA)
    expect(env.repo.block(rowA).peekProperty(annotationMarginOpenProp)).toBe(true)
    expect(env.repo.block(rowA).peekProperty(annotationMarginShareProp)).toBe(0.37)
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBe('m')

    await applyUrl('#ws-1/a;view=m')
    expect((await byBlock()).get('a')).toBe(rowA)
    expect(env.repo.block(rowA).peekProperty(annotationMarginOpenProp)).toBe(false)
    expect(env.repo.block(rowA).peekProperty(annotationMarginShareProp)).toBe(0.37)
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBe('m')
  })

  it('retargets comment flags across reordered and reused rows', async () => {
    await applyUrl('#ws-1/a;comments/b')
    const original = await byBlock()

    await applyUrl('#ws-1/b;comments/a/c;comments')
    const updated = await byBlock()
    expect(updated.get('a')).toBe(original.get('a'))
    expect(updated.get('b')).toBe(original.get('b'))
    expect(env.repo.block(updated.get('a')!).peekProperty(annotationMarginOpenProp)).toBe(false)
    expect(env.repo.block(updated.get('b')!).peekProperty(annotationMarginOpenProp)).toBe(true)
    expect(env.repo.block(updated.get('c')!).peekProperty(annotationMarginOpenProp)).toBe(true)
    expect([...updated.keys()]).toEqual(['b', 'a', 'c'])
  })

  it('flags duplicate blocks independently by pane occurrence', async () => {
    await applyUrl('#ws-1/same;comments/same')
    const [first, second] = (await rows()).map(row => row.id)

    expect(first).not.toBe(second)
    expect(env.repo.block(first).peekProperty(annotationMarginOpenProp)).toBe(true)
    expect(env.repo.block(second).peekProperty(annotationMarginOpenProp)).toBeFalsy()
  })

  it('projects panel changes to history while preserving view and unknown slot entries', async () => {
    await applyUrl('#ws-1/a;future-slot=x;view=m/b')
    const rowA = (await byBlock()).get('a')!
    const {projection, pushes, hash} = startProjection('#ws-1/a;future-slot=x;view=m/b')
    await projection.start()

    await env.repo.block(rowA).set(annotationMarginOpenProp, true)
    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/a;comments;future-slot=x;view=m/b']))
    await env.repo.block(rowA).set(annotationMarginOpenProp, false)
    await vi.waitFor(() => expect(pushes).toEqual([
      '#ws-1/a;comments;future-slot=x;view=m/b',
      '#ws-1/a;future-slot=x;view=m/b',
    ]))
    expect(hash()).toBe('#ws-1/a;future-slot=x;view=m/b')
    projection.dispose()
  })

  it('restores the margin flag on browser back and from a workspace-only URL', async () => {
    await applyUrl('#ws-1/a;comments')
    const rowA = (await byBlock()).get('a')!
    const {projection, setHash} = startProjection('#ws-1/a;comments')
    await projection.start()

    setHash('#ws-1/a')
    await projection.applyCurrentUrl()
    expect(env.repo.block(rowA).peekProperty(annotationMarginOpenProp)).toBe(false)

    await env.repo.block(rowA).set(annotationMarginOpenProp, true)
    setHash('#ws-1')
    await projection.applyCurrentUrl()
    expect(env.repo.block(rowA).peekProperty(annotationMarginOpenProp)).toBe(true)
    projection.dispose()
  })

  it('canonicalizes ;comments=true and removes ;comments=false', async () => {
    const replacements: string[] = []
    await applyUrl('#ws-1/a;comments=true', hash => replacements.push(hash))
    const rowA = (await byBlock()).get('a')!
    expect(env.repo.block(rowA).peekProperty(annotationMarginOpenProp)).toBe(true)
    expect(replacements).toContain('#ws-1/a;comments')

    await applyUrl('#ws-1/a;comments=false', hash => replacements.push(hash))
    expect((await byBlock()).get('a')).toBe(rowA)
    expect(env.repo.block(rowA).peekProperty(annotationMarginOpenProp)).toBe(false)
    expect(replacements).toContain('#ws-1/a')
  })
})

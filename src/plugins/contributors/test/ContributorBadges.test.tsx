// @vitest-environment happy-dom
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Block} from '@/data/block'
import type {BlockData} from '@/data/api'
import {USER_TYPE} from '@/data/blockTypes'
import {typesProp} from '@/data/properties'

const {useHandleMock, useOpenBlockMock} = vi.hoisted(() => ({
  useHandleMock: vi.fn(),
  useOpenBlockMock: vi.fn(),
}))
vi.mock('@/hooks/block.js', () => ({useHandle: useHandleMock}))
vi.mock('@/utils/navigation.js', () => ({useOpenBlock: useOpenBlockMock}))
vi.mock('@/context/layoutWsContext.js', () => ({useAppHashInContext: (_ws: string, id: string) => `#${id}`}))

import {contributorBadgesDecoratorContribution} from '../ContributorBadges.js'
import {attributionCreatorsProp, attributionEditorsProp, contributorKindProp, contributorRoleProp} from '../schema.js'
import {CONTRIBUTOR_PROFILES_BY_IDS_QUERY} from '../queries.js'

const blockData = (properties: Record<string, unknown>): BlockData => ({
  id: 'note', workspaceId: 'ws', content: 'A note', parentId: null, orderKey: 'a',
  createdAt: 1, createdBy: 'human', userUpdatedAt: 2, updatedBy: 'agent', updatedAt: 2,
  deleted: false, properties, types: [],
} as unknown as BlockData)
const profile = (id: string, name: string, kind: string, role?: string): BlockData => ({
  ...blockData({
    [contributorKindProp.name]: contributorKindProp.codec.encode(kind as never),
    [contributorRoleProp.name]: role,
  }), id, content: name,
})
const profileRows = new Map<string, BlockData>()
const setProfiles = (...rows: BlockData[]) => {
  profileRows.clear()
  for (const row of rows) profileRows.set(row.id, row)
}
const profileQueryHandle = {}
const block = {id: 'note', repo: {
  query: {
    [CONTRIBUTOR_PROFILES_BY_IDS_QUERY]: () => profileQueryHandle,
  },
}} as unknown as Block
const Inner = ({block: b}: {block: Block}) => <span>Body {b.id}</span>
const decorate = (properties: Record<string, unknown>) => {
  useHandleMock.mockImplementation((handle: unknown, options: {selector: (data: unknown) => unknown}) =>
    handle === block
      ? options.selector(blockData(properties))
      : options.selector([...profileRows.values()]))
  const render = contributorBadgesDecoratorContribution({block} as never)
  if (!render) throw new Error('expected contributor decorator')
  return render(Inner)
}

beforeEach(() => {
  useOpenBlockMock.mockReturnValue(() => {})
  profileRows.clear()
  setProfiles(profile('agent', 'Research Agent', 'agent', 'research'), profile('human', 'Alice', 'human'))
})
afterEach(() => {cleanup(); vi.clearAllMocks()})

describe('contributor badges', () => {
  it('keeps plain content free of badge chrome when attribution has no agent', () => {
    const Decorated = decorate({
      [attributionCreatorsProp.name]: attributionCreatorsProp.codec.encode(['human']),
      [attributionEditorsProp.name]: attributionEditorsProp.codec.encode([]),
    })
    const {container} = render(<Decorated block={block}/>)
    expect(screen.getByText('Body note')).toBeTruthy()
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('.flex.w-full')).toBeNull()
  })

  it('reflects profile edits in the badge and open details', async () => {
    const Decorated = decorate({
      [attributionCreatorsProp.name]: attributionCreatorsProp.codec.encode(['agent']),
      [attributionEditorsProp.name]: attributionEditorsProp.codec.encode([]),
    })
    setProfiles(profile('agent', 'Research Agent', 'agent', 'research'))
    const view = render(<Decorated block={block}/>)
    expect(screen.getByRole('button', {name: 'Authorship details: By Research Agent'}).textContent).toBe('Research Agent')

    act(() => setProfiles(profile('agent', 'Updated Agent', 'automation', 'summarizer')))
    view.rerender(<Decorated block={block}/>)
    expect(screen.getByRole('button', {name: 'Authorship details: By Updated Agent'}).textContent).toBe('Updated Agent')
    expect(screen.getByRole('button', {name: 'Authorship details: By Updated Agent'}).getAttribute('title')).toBe('By Updated Agent')
    fireEvent.pointerDown(screen.getByRole('button', {name: /Authorship details/}), {button: 0, pointerType: 'mouse'})
    await screen.findByRole('menu')
    expect(screen.getByText('automation · summarizer')).toBeTruthy()
  })

  it('treats a USER_TYPE profile as human even when its stored kind is agent', () => {
    const Decorated = decorate({
      [attributionCreatorsProp.name]: attributionCreatorsProp.codec.encode(['agent']),
      [attributionEditorsProp.name]: attributionEditorsProp.codec.encode([]),
    })
    setProfiles(profile('agent', 'Research Agent', 'agent', 'research'))
    const view = render(<Decorated block={block}/>)
    expect(screen.getByRole('button', {name: /Research Agent/})).toBeTruthy()

    act(() => setProfiles({
      ...profile('agent', 'Research Agent', 'agent', 'research'),
      properties: {
        ...profile('agent', 'Research Agent', 'agent', 'research').properties,
        [typesProp.name]: typesProp.codec.encode([USER_TYPE]),
      },
    }))
    view.rerender(<Decorated block={block}/>)
    expect(screen.queryByRole('button', {name: /Authorship details/})).toBeNull()
    expect(screen.getByText('Body note')).toBeTruthy()
  })

  it('keeps repeated and additional contributors compact with a count', () => {
    const Decorated = decorate({
      [attributionCreatorsProp.name]: attributionCreatorsProp.codec.encode(['agent', 'agent', 'other']),
      [attributionEditorsProp.name]: attributionEditorsProp.codec.encode([]),
    })
    setProfiles(profile('agent', 'Research Agent', 'agent', 'research'), profile('other', 'Writer Bot', 'automation', 'writer'))
    render(<Decorated block={block}/>)
    expect(screen.getByRole('button', {name: 'Authorship details: By Research Agent, Writer Bot'}).textContent).toBe('Research Agent+1')
  })

  it('uses the first non-human editor as the badge primary when there is no non-human creator', () => {
    const Decorated = decorate({
      [attributionCreatorsProp.name]: attributionCreatorsProp.codec.encode(['human']),
      [attributionEditorsProp.name]: attributionEditorsProp.codec.encode(['writer']),
    })
    setProfiles(profile('human', 'Alice', 'human'), profile('writer', 'Writer Bot', 'automation', 'writer'))
    render(<Decorated block={block}/>)
    const badge = screen.getByRole('button', {name: 'Authorship details: Edited by Writer Bot'})
    expect(badge.textContent).toBe('Writer Bot')
    expect(badge.querySelector('svg')).toBeTruthy()
  })

  it('omits a creator from the editor summary but keeps mixed editor attribution in details', async () => {
    const Decorated = decorate({
      [attributionCreatorsProp.name]: attributionCreatorsProp.codec.encode(['agent']),
      [attributionEditorsProp.name]: attributionEditorsProp.codec.encode(['agent', 'writer', 'reviewer', 'human']),
    })
    setProfiles(
      profile('agent', 'Research Agent', 'agent', 'research'),
      profile('writer', 'Writer Bot', 'automation', 'writer'),
      profile('reviewer', 'Review Bot', 'agent', 'reviewer'),
      profile('human', 'Alice', 'human'),
    )
    render(<Decorated block={block}/>)
    const badge = screen.getByRole('button', {name: /Authorship details/})
    expect(badge.textContent).toBe('Research Agent+2')
    expect(badge.getAttribute('title')).toBe('By Research Agent · Edited by Writer Bot, Review Bot')

    fireEvent.pointerDown(badge, {button: 0, pointerType: 'mouse'})
    await screen.findByRole('menu')
    expect(screen.getAllByRole('menuitem', {name: /Research Agent/})).toHaveLength(2)
    expect(screen.getByRole('menuitem', {name: /Alice human/})).toBeTruthy()
    expect(screen.getByRole('menuitem', {name: /Review Bot agent · reviewer/})).toBeTruthy()
    expect(badge.textContent).not.toContain('research')
    expect(badge.textContent).not.toContain('writer')
  })

  it('shows each contributor once in the badge while retaining creator/editor detail records', async () => {
    const Decorated = decorate({
      [attributionCreatorsProp.name]: attributionCreatorsProp.codec.encode(['human', 'agent']),
      [attributionEditorsProp.name]: attributionEditorsProp.codec.encode(['agent']),
    })
    render(<Decorated block={block}/>)
    expect(screen.getByRole('button', {name: 'Authorship details: By Research Agent'}).textContent).toBe('Research Agent')
    fireEvent.pointerDown(screen.getByRole('button', {name: /Authorship details/}), {button: 0, pointerType: 'mouse'})
    await screen.findByRole('menu')

    expect(screen.getByText('Created by')).toBeTruthy()
    expect(screen.getByText('Edited by')).toBeTruthy()
    expect(screen.getByRole('menuitem', {name: 'Alice human'}).getAttribute('href')).toBe('#human')
    expect(screen.getAllByRole('menuitem', {name: /Research Agent/})).toHaveLength(2)
    expect(screen.getByText('human')).toBeTruthy()
    expect(screen.getAllByText('agent · research')).toHaveLength(2)
    expect(useOpenBlockMock).toHaveBeenCalledWith({blockId: 'agent', workspaceId: 'ws'})
    fireEvent.keyDown(screen.getByRole('menu'), {key: 'Escape'})
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

// @vitest-environment happy-dom
import {cleanup, fireEvent, render, screen} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Block} from '@/data/block'
import type {BlockData} from '@/data/api'
import {USER_TYPE} from '@/data/blockTypes'
import {typesProp} from '@/data/properties'

const {useHandleMock, useHandlesMock, useOpenBlockMock} = vi.hoisted(() => ({
  useHandleMock: vi.fn(),
  useHandlesMock: vi.fn(),
  useOpenBlockMock: vi.fn(),
}))
vi.mock('@/hooks/block.js', () => ({useHandle: useHandleMock, useHandles: useHandlesMock}))
vi.mock('@/utils/navigation.js', () => ({useOpenBlock: useOpenBlockMock}))
vi.mock('@/context/layoutWsContext.js', () => ({useAppHashInContext: (_ws: string, id: string) => `#${id}`}))

import {contributorBadgesDecoratorContribution} from '../ContributorBadges.js'
import {attributionCreatorsProp, attributionEditorsProp, contributorKindProp, contributorRoleProp} from '../schema.js'

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
const block = {id: 'note', repo: {block: (id: string) => ({id})}} as unknown as Block
const Inner = ({block: b}: {block: Block}) => <span>Body {b.id}</span>
const decorate = (properties: Record<string, unknown>) => {
  useHandleMock.mockImplementation((_block: Block, options: {selector: (data: BlockData) => unknown}) => options.selector(blockData(properties)))
  const render = contributorBadgesDecoratorContribution({block} as never)
  if (!render) throw new Error('expected contributor decorator')
  return render(Inner)
}

beforeEach(() => {
  useOpenBlockMock.mockReturnValue(() => {})
  useHandlesMock.mockImplementation((handles: readonly {id: string}[]) => handles.map(handle => ({
    agent: profile('agent', 'Research Agent', 'agent', 'research'),
    human: profile('human', 'Alice', 'human'),
  }[handle.id])))
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
    let current = profile('agent', 'Research Agent', 'agent', 'research')
    useHandlesMock.mockImplementation((handles: readonly {id: string}[]) => handles.map(handle => handle.id === 'agent' ? current : undefined))
    const view = render(<Decorated block={block}/>)
    expect(screen.getByRole('button', {name: 'Authorship details: By Research Agent · research'})).toBeTruthy()

    current = profile('agent', 'Updated Agent', 'automation', 'summarizer')
    view.rerender(<Decorated block={block}/>)
    expect(screen.getByRole('button', {name: 'Authorship details: By Updated Agent · summarizer'})).toBeTruthy()
    fireEvent.pointerDown(screen.getByRole('button', {name: /Authorship details/}), {button: 0, pointerType: 'mouse'})
    await screen.findByRole('menu')
    expect(screen.getByText('automation · summarizer')).toBeTruthy()
  })

  it('treats a USER_TYPE profile as human even when its stored kind is agent', () => {
    const Decorated = decorate({
      [attributionCreatorsProp.name]: attributionCreatorsProp.codec.encode(['agent']),
      [attributionEditorsProp.name]: attributionEditorsProp.codec.encode([]),
    })
    let current = profile('agent', 'Research Agent', 'agent', 'research')
    useHandlesMock.mockImplementation((handles: readonly {id: string}[]) => handles.map(handle => handle.id === 'agent' ? current : undefined))
    const view = render(<Decorated block={block}/>)
    expect(screen.getByRole('button', {name: /Research Agent/})).toBeTruthy()

    current = {
      ...current,
      properties: {
        ...current.properties,
        [typesProp.name]: typesProp.codec.encode([USER_TYPE]),
      },
    }
    view.rerender(<Decorated block={block}/>)
    expect(screen.queryByRole('button', {name: /Authorship details/})).toBeNull()
    expect(screen.getByText('Body note')).toBeTruthy()
  })

  it('keeps repeated and additional contributors compact with a count', () => {
    const Decorated = decorate({
      [attributionCreatorsProp.name]: attributionCreatorsProp.codec.encode(['agent', 'agent', 'other']),
      [attributionEditorsProp.name]: attributionEditorsProp.codec.encode([]),
    })
    useHandlesMock.mockImplementation((handles: readonly {id: string}[]) => handles.map(handle => ({
      agent: profile('agent', 'Research Agent', 'agent', 'research'),
      other: profile('other', 'Writer Bot', 'automation', 'writer'),
    }[handle.id])))
    render(<Decorated block={block}/>)
    expect(screen.getByRole('button', {name: 'Authorship details: By Research Agent · research +1'})).toBeTruthy()
  })

  it('omits a creator from the editor summary but keeps mixed editor attribution in details', async () => {
    const Decorated = decorate({
      [attributionCreatorsProp.name]: attributionCreatorsProp.codec.encode(['agent']),
      [attributionEditorsProp.name]: attributionEditorsProp.codec.encode(['agent', 'writer', 'reviewer', 'human']),
    })
    useHandlesMock.mockImplementation((handles: readonly {id: string}[]) => handles.map(handle => ({
      agent: profile('agent', 'Research Agent', 'agent', 'research'),
      writer: profile('writer', 'Writer Bot', 'automation', 'writer'),
      reviewer: profile('reviewer', 'Review Bot', 'agent', 'reviewer'),
      human: profile('human', 'Alice', 'human'),
    }[handle.id])))
    render(<Decorated block={block}/>)
    const badge = screen.getByRole('button', {name: /Authorship details/})
    expect(badge.textContent).toBe('By Research Agent · research · Edited by Writer Bot · writer +1')

    fireEvent.pointerDown(badge, {button: 0, pointerType: 'mouse'})
    await screen.findByRole('menu')
    expect(screen.getAllByRole('menuitem', {name: /Research Agent/})).toHaveLength(2)
    expect(screen.getByRole('menuitem', {name: /Alice human/})).toBeTruthy()
    expect(screen.getByRole('menuitem', {name: /Review Bot agent · reviewer/})).toBeTruthy()
  })

  it('shows each contributor once in the badge while retaining creator/editor detail records', async () => {
    const Decorated = decorate({
      [attributionCreatorsProp.name]: attributionCreatorsProp.codec.encode(['human', 'agent']),
      [attributionEditorsProp.name]: attributionEditorsProp.codec.encode(['agent']),
    })
    render(<Decorated block={block}/>)
    expect(screen.getByRole('button', {name: 'Authorship details: By Research Agent · research'}).textContent).toBe('By Research Agent · research')
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

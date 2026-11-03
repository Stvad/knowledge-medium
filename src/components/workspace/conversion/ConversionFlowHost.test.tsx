// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RepoContext } from '@/context/repo'
import type { Repo } from '@/data/repo'
import { cancelArmedHolds } from '@/shortcuts/holdRegistry'
import { ConversionFlowHost } from './ConversionFlowHost'
import { conversionSetup } from './conversionFlowDeps'
import { closeConversionFlow, conversionFlowTarget, openConversionFlow } from './conversionFlowStore'

vi.mock('@/components/Login', () => ({useIsLocalOnly: () => false}))
vi.mock('@/shortcuts/holdRegistry', () => ({cancelArmedHolds: vi.fn()}))
vi.mock('./conversionFlowDeps', async orig => {
  const actual = await orig<typeof import('./conversionFlowDeps')>()
  return {...actual, conversionSetup: vi.fn(actual.conversionSetup)}
})

const USER = 'user-1'
const repo = {user: {id: USER}} as unknown as Repo

const renderHost = () => render(
  <RepoContext.Provider value={repo}>
    <ConversionFlowHost/>
  </RepoContext.Provider>,
)

afterEach(() => {
  cleanup()
  act(() => closeConversionFlow())
  vi.mocked(cancelArmedHolds).mockClear()
})

describe('ConversionFlowHost', () => {
  it('never shows one account the flow another account opened', () => {
    act(() => openConversionFlow({userId: 'someone-else', workspaceId: 'ws', workspaceName: 'Theirs'}))
    renderHost()

    expect(screen.queryByText(/theirs/i)).toBeNull()
    expect(conversionFlowTarget()).toBeNull()
  })

  it('can be closed while it is still preparing', async () => {
    vi.mocked(conversionSetup).mockReturnValueOnce(new Promise(() => {}))
    act(() => openConversionFlow({userId: USER, workspaceId: 'ws', workspaceName: 'Vault'}))
    renderHost()
    expect(screen.getByText('Preparing the conversion…')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', {name: 'Close'}))

    expect(conversionFlowTarget()).toBeNull()
  })

  it('keeps every key from the shortcuts underneath, and cancels a hold armed before it opened', async () => {
    const reached: string[] = []
    const listen = (event: KeyboardEvent) => reached.push(event.type)
    window.addEventListener('keydown', listen)
    window.addEventListener('keyup', listen)
    try {
      act(() => openConversionFlow({userId: USER, workspaceId: 'ws', workspaceName: 'Vault'}))
      renderHost()
      const inside = await screen.findByRole('button', {name: /close/i})

      fireEvent.keyDown(inside, {key: 'Enter'})
      fireEvent.keyUp(inside, {key: 'Enter'})

      expect(reached).toEqual([])
      expect(cancelArmedHolds).toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', listen)
      window.removeEventListener('keyup', listen)
    }
  })
})

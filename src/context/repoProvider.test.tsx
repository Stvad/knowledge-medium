// @vitest-environment happy-dom
import { act, render, screen } from '@testing-library/react'
import { Suspense } from 'react'
import { ErrorBoundary } from 'react-error-boundary'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo'
import { RepoProvider, createRepoBoot, useRepo } from '@/context/repo.tsx'

vi.mock('@/components/Login', () => ({
  useUser: () => ({id: 'user-1', name: 'u'}),
  useIsLocalOnly: () => true,
}))

// A boot still pending must render RepoProvider's own loading UI, not suspend
// into the enclosing Suspense boundary: that boundary's fallback flip is what
// React 19 throttles the next commit against (see createRepoBoot).
const Probe = () => <div>suspense-fallback-mounted</div>
const Child = () => <div>repo:{String(!!useRepo())}</div>
const user = {id: 'user-1', name: 'u'}

describe('RepoProvider', () => {
  it('waits as state, then renders children, without a Suspense fallback', async () => {
    let resolve!: (repo: Repo) => void
    const boot = createRepoBoot(async () => {}, () => new Promise<Repo>(r => { resolve = r }))
    render(
      <Suspense fallback={<Probe/>}>
        <RepoProvider boot={boot}><Child/></RepoProvider>
      </Suspense>,
    )
    expect(screen.getByText('Loading...')).toBeTruthy()
    expect(screen.queryByText('suspense-fallback-mounted')).toBeNull()
    await act(async () => { resolve({db: undefined} as unknown as Repo) })
    expect(await screen.findByText('repo:true')).toBeTruthy()
    expect(screen.queryByText('suspense-fallback-mounted')).toBeNull()
  })

  it('throws a rejected boot into the enclosing error boundary', async () => {
    const boot = createRepoBoot(async () => {}, () => Promise.reject(new Error('boot failed')))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary fallbackRender={({error}) => <div>caught:{(error as Error).message}</div>}>
        <RepoProvider boot={boot}><Child/></RepoProvider>
      </ErrorBoundary>,
    )
    expect(await screen.findByText('caught:boot failed')).toBeTruthy()
    spy.mockRestore()
  })
})

describe('createRepoBoot', () => {
  it('resolves only after the layout is prepared, and a prepare failure fails the boot', async () => {
    const repo = {} as Repo
    const order: string[] = []
    const init = vi.fn(async () => { order.push('init'); return repo })
    let releasePrepare!: () => void
    const prepare = vi.fn(() => new Promise<void>(r => { releasePrepare = () => { order.push('prepared'); r() } }))
    let settled = false
    const promise = createRepoBoot(prepare, init)(user, true).then(r => { settled = true; return r })
    await Promise.resolve(); await Promise.resolve()
    expect(prepare).toHaveBeenCalledWith(repo, true)
    expect(settled).toBe(false)
    releasePrepare()
    expect(await promise).toBe(repo)
    expect(order).toEqual(['init', 'prepared'])

    const failing = createRepoBoot(async () => { throw new Error('layout failed') }, init)
    await expect(failing(user, false)).rejects.toThrow('layout failed')
  })
})

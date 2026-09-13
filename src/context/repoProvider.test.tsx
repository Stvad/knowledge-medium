// @vitest-environment happy-dom
import { act, render, screen } from '@testing-library/react'
import { Suspense } from 'react'
import { ErrorBoundary } from 'react-error-boundary'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo'
import { RepoProvider, composeBoot, useRepo } from '@/context/repo.tsx'

vi.mock('@/components/Login', () => ({
  useUser: () => ({id: 'user-1', name: 'u'}),
  useIsLocalOnly: () => true,
}))

// A boot that is still pending must render RepoProvider's own loading UI, not
// suspend into the enclosing Suspense boundary: that boundary's fallback flip
// is what React 19 throttles the next commit against (see bootRepo).
const Probe = () => <div>suspense-fallback-mounted</div>
const Child = () => <div>repo:{String(!!useRepo())}</div>

describe('RepoProvider', () => {
  it('waits as state, then renders children, without a Suspense fallback', async () => {
    let resolve!: (repo: Repo) => void
    const boot = () => new Promise<Repo>(r => { resolve = r })
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

  it('renders children immediately when the boot promise is already settled', async () => {
    const repo = {db: undefined} as unknown as Repo
    const boot = () => Promise.resolve(repo)
    const promise = boot()
    await promise
    render(<RepoProvider boot={() => promise}><Child/></RepoProvider>)
    // First render sees no settled stamp (the stamp lands on a microtask), so
    // one loading render is allowed; children must follow without a fallback.
    expect(await screen.findByText('repo:true')).toBeTruthy()
  })

  it('throws a rejected boot into the enclosing error boundary', async () => {
    const boot = () => Promise.reject(new Error('boot failed'))
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

describe('composeBoot', () => {
  it('resolves only after the layout is prepared, and a prepare failure does not fail the boot', async () => {
    const repo = {} as Repo
    const order: string[] = []
    const init = vi.fn(async () => { order.push('init'); return repo })
    let releasePrepare!: () => void
    const prepare = vi.fn(() => new Promise<void>(r => { releasePrepare = () => { order.push('prepared'); r() } }))
    const boot = composeBoot(init, prepare)
    let settled = false
    const promise = boot({id: 'u', name: 'u'}, true).then(r => { settled = true; return r })
    await Promise.resolve(); await Promise.resolve()
    expect(prepare).toHaveBeenCalledWith(repo, true)
    expect(settled).toBe(false)
    releasePrepare()
    expect(await promise).toBe(repo)
    expect(order).toEqual(['init', 'prepared'])

    const failing = composeBoot(init, async () => { throw new Error('layout failed') })
    await expect(failing({id: 'u', name: 'u'}, false)).resolves.toBe(repo)
  })
})

// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => ({
  createRoot: vi.fn(() => ({render: vi.fn()})),
  installDbForensicsLifecycle: vi.fn(),
  registerServiceWorker: vi.fn(),
  requestPersistentStorage: vi.fn(async () => {}),
  setDevAssertionsEnabled: vi.fn(),
  startCurrentPreviewScopeLease: vi.fn(async () => {}),
  startStartupObservers: vi.fn(),
}))

vi.mock('react-dom/client', () => ({createRoot: mocks.createRoot}))
vi.mock('./App.tsx', () => ({default: () => null}))
vi.mock('@/context/repo.js', () => ({RepoProvider: ({children}: {children: unknown}) => children}))
vi.mock('@/components/Login.js', () => ({Login: ({children}: {children: unknown}) => children}))
vi.mock('@/components/util/suspense.js', () => ({SuspenseFallback: () => null}))
vi.mock('@/components/util/error.js', () => ({
  BootstrapErrorFallback: () => null,
  LocalDbCorruptionSentinel: () => null,
}))
vi.mock('@/registerServiceWorker.js', () => ({registerServiceWorker: mocks.registerServiceWorker}))
vi.mock('@/requestPersistentStorage.js', () => ({requestPersistentStorage: mocks.requestPersistentStorage}))
vi.mock('@/data/internals/devAssertions.js', () => ({
  setDevAssertionsEnabled: mocks.setDevAssertionsEnabled,
}))
vi.mock('@/utils/startupTimeline.js', () => ({startStartupObservers: mocks.startStartupObservers}))
vi.mock('@/utils/dbForensicsHooks.js', () => ({
  installDbForensicsLifecycle: mocks.installDbForensicsLifecycle,
}))
vi.mock('@/sw/previewDatabases.js', () => ({
  startCurrentPreviewScopeLease: mocks.startCurrentPreviewScopeLease,
}))

afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('main bootstrap', () => {
  it('waits for the current preview scope lease before rendering', async () => {
    vi.stubEnv('BASE_URL', '/knowledge-medium/pr-preview/pr-328/')
    document.body.innerHTML = '<div id="root"></div>'
    let releaseLease!: () => void
    mocks.startCurrentPreviewScopeLease.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseLease = resolve
      }),
    )

    const main = import('./main')
    await vi.waitFor(() => expect(mocks.startCurrentPreviewScopeLease).toHaveBeenCalled())

    expect(mocks.createRoot).not.toHaveBeenCalled()
    releaseLease()
    await main

    expect(mocks.startCurrentPreviewScopeLease).toHaveBeenCalledWith(
      '/knowledge-medium/pr-preview/pr-328/',
      window.location.href,
    )
    await vi.waitFor(() => expect(mocks.createRoot).toHaveBeenCalled())
  })
})

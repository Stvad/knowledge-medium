// @vitest-environment happy-dom
import {act, render, screen, waitFor} from '@testing-library/react'
import {expect, it, vi} from 'vitest'
import {AppRuntimeProvider} from '@/extensions/AppRuntimeProvider.js'
import {useAppRuntime} from '@/extensions/runtimeContext.js'
import {defineFacet, type AppExtension, type FacetResolveContext, type FacetRuntime} from '@/facets/facet.js'

const host = vi.hoisted(() => ({
  repo: {activeWorkspaceId: 'ws', setFacetRuntime: vi.fn<(runtime: FacetRuntime) => void>()},
  generation: 'initial',
  overrides: new Map<string, boolean>(),
  staticExtensions: [] as AppExtension[],
  load: vi.fn<(context: FacetResolveContext) => Promise<AppExtension>>(),
}))

vi.mock('@/context/repo.js', () => ({useRepo: () => host.repo}))
vi.mock('@/extensions/useOverrides.js', () => ({
  useOverrides: () => ({overrides: host.overrides, generation: host.generation}),
}))
vi.mock('@/extensions/staticAppExtensions.js', () => ({staticAppExtensions: () => host.staticExtensions}))
vi.mock('@/extensions/dynamicExtensions.js', () => ({dynamicExtensionsExtension: () => host.load}))
vi.mock('@/extensions/extensionUtilitiesCss.js', () => ({ensureExtensionUtilitiesCss: async () => {}}))
vi.mock('@/shortcuts/HotkeyReconciler.js', () => ({HotkeyReconciler: () => null}))

const labels = defineFacet<string>({id: 'test.tab-runtime-labels'})

function RuntimeReader() {
  const runtime = useAppRuntime()
  return <output>{runtime.read(labels).join(', ')}</output>
}

it('installs the static runtime on mount and replaces it when extensions resolve', async () => {
  let finishLoad!: (extension: AppExtension) => void
  const firstLoad = new Promise<AppExtension>(resolve => { finishLoad = resolve })
  host.staticExtensions = [labels.of('static')]
  host.load.mockReturnValueOnce(firstLoad)
  const installed = () => host.repo.setFacetRuntime.mock.calls.map(([runtime]) => runtime.read(labels))
  const view = () => <AppRuntimeProvider safeMode={false}><RuntimeReader/></AppRuntimeProvider>

  const {rerender} = render(view())
  expect(screen.getByRole('status')).toHaveTextContent('static')
  expect(installed()).toEqual([['static']])

  await act(async () => { finishLoad(labels.of('loaded')) })
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('static, loaded'))
  expect(installed()).toEqual([['static'], ['static', 'loaded']])

  host.generation = 'refresh'
  host.load.mockImplementationOnce(async context => labels.of(String(context.generation)))
  rerender(view())
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('static, refresh'))
  expect(installed()).toEqual([['static'], ['static', 'loaded'], ['static', 'refresh']])
})

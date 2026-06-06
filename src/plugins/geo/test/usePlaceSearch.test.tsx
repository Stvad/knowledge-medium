// @vitest-environment jsdom
/**
 * usePlaceSearch combines a local Place-block scan with Google autocomplete.
 * The behaviour worth pinning is the failure handling the `@`/property pickers
 * depend on: a Google HTTP/network error must NOT blank the dropdown — local
 * matches stay, and the error is surfaced for the UI to show.
 *
 * The Google client is mocked at the module boundary (real GooglePlacesError
 * kept, so the `instanceof` branch runs); the repo is a thin stub so the test
 * needs no DB.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aliasesProp } from '@/data/internals/coreProperties'
import { typesProp } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { PLACE_TYPE } from '../blockTypes'

const mock = vi.hoisted(() => ({ autocomplete: vi.fn() }))

vi.mock('../googlePlacesClient', async (importActual) => {
  const actual = await importActual<typeof import('../googlePlacesClient')>()
  return {
    ...actual,
    resolveApiKey: () => 'test-key', // force the Google path on
    createGooglePlacesClient: () => ({
      autocomplete: mock.autocomplete,
      getDetails: vi.fn(),
      searchNearby: vi.fn(),
    }),
  }
})

import { usePlaceSearch } from '../usePlaceSearch'
import { GooglePlacesError } from '../googlePlacesClient'

const placeBlock = {
  id: 'p1',
  content: 'Cafe Blue',
  properties: {
    [typesProp.name]: [PLACE_TYPE],
    [aliasesProp.name]: ['Cafe Blue'],
  },
}

const stubRepo = (): Repo => ({
  activeWorkspaceId: 'ws-1',
  query: { byType: () => ({ load: async () => [placeBlock] }) },
}) as unknown as Repo

const localResult = { id: 'p1', source: 'local', label: 'Cafe Blue', detail: undefined }

beforeEach(() => { vi.useFakeTimers(); mock.autocomplete.mockReset() })
afterEach(() => { vi.useRealTimers() })

describe('usePlaceSearch', () => {
  it('appends Google suggestions after local matches on success', async () => {
    mock.autocomplete.mockResolvedValue([{ placeId: 'g1', primary: 'Cafe Green', secondary: 'Main St' }])
    const repo = stubRepo()
    const { result } = renderHook(() => usePlaceSearch(repo))

    act(() => { result.current.search('cafe') })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) }) // past the 250ms debounce

    expect(result.current.error).toBeNull()
    expect(result.current.results).toEqual([
      localResult,
      { id: 'google:g1', source: 'google', label: 'Cafe Green', detail: 'Main St' },
    ])
  })

  it('keeps local results and surfaces the error when Google autocomplete fails', async () => {
    mock.autocomplete.mockRejectedValue(new GooglePlacesError('network', null, 'socket reset'))
    const repo = stubRepo()
    const { result } = renderHook(() => usePlaceSearch(repo))

    act(() => { result.current.search('cafe') })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    expect(result.current.results).toEqual([localResult])
    expect(result.current.error).toMatch(/^Google network \(/)
  })
})

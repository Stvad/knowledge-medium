// @vitest-environment happy-dom

/** The data hook, at the tier where its state machine is visible.
 *
 *  Everything `useProgram` decides that is not a pure function lives in one
 *  effect and three latches, and none of it is reachable from the pure tests:
 *
 *   - `configLoaded` gates WRITING. Every path out of the plan read has to
 *     release it, including the failing one — an unreadable plan that left
 *     logging locked forever is worse than logging against default names.
 *   - a failed read means two different things depending on whether a plan
 *     was ever read, and the difference is what the user is told about the
 *     session they are about to record.
 *   - `liveLoaded` is the difference between "the blocks haven't arrived" and
 *     "that lift has no sets any more".
 *
 *  The plan read and the settings block are faked here (they are covered
 *  against a real repo elsewhere); the hook's own sequencing is not.
 */

import {act, cleanup, renderHook, waitFor} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import type {Repo} from '@/data/repo.js'

import {DEFAULT_CONFIG} from '../src/program/defaults'
import type {ProgramConfig} from '../src/engine/types'
import {useProgram} from '../src/ui/useProgram'
import {publishTree, resetBlockHooks} from './kernel/blockHooks'

vi.mock('../src/km/page', () => ({getOrCreateSettingsBlock: vi.fn(async () => 'settings-1')}))
vi.mock('../src/km/config', () => ({loadConfig: vi.fn()}))
vi.mock('../src/km/store', () => ({writeAltChoice: vi.fn(async () => undefined)}))

const {loadConfig} = await import('../src/km/config')
const {writeAltChoice} = await import('../src/km/store')

/** A plan whose identity is visible in the result — `planRootId` is the
 *  cheapest thing to assert "this config, not that one" on. */
const planned = (rootId: string): {config: ProgramConfig; warnings: string[]; planRootId: string} =>
  ({config: {...DEFAULT_CONFIG, dayRolloverHour: 4}, warnings: [], planRootId: rootId})

const repo = {query: {typedBlocks: () => ({})}} as unknown as Repo
const mount = () => renderHook(() => useProgram(repo, 'ws-1', 'page-1'))

beforeEach(() => {
  resetBlockHooks()
  vi.mocked(loadConfig).mockReset()
  vi.mocked(writeAltChoice).mockReset().mockResolvedValue(undefined)
  // The failure paths log deliberately; keep the suite's output about the
  // suite.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the write latch', () => {
  it('is closed until the plan has been read', async () => {
    // `config` is seeded with the defaults so the surface renders instantly,
    // but those carry no plan-block ids and a logged entry's id derives from
    // its plan block. Writing before the read lands builds a whole parallel
    // tree of name-keyed blocks beside the real ones.
    let release: (value: ReturnType<typeof planned>) => void = () => {}
    vi.mocked(loadConfig).mockReturnValue(new Promise(resolve => { release = resolve }))

    const {result} = mount()
    expect(result.current.configLoaded).toBe(false)
    expect(result.current.config).toEqual(DEFAULT_CONFIG)

    await act(async () => { release(planned('plan-root')) })

    expect(result.current.configLoaded).toBe(true)
    expect(result.current.planRootId).toBe('plan-root')
  })

  it('opens even when the read FAILED, rather than locking logging forever', async () => {
    vi.mocked(loadConfig).mockRejectedValue(new Error('outline unreadable'))

    const {result} = mount()

    await waitFor(() => expect(result.current.configLoaded).toBe(true))
    expect(result.current.config).toEqual(DEFAULT_CONFIG)
    expect(result.current.warnings.join(' ')).toContain('built-in defaults')
  })

  it('closes again for the duration of a reload', async () => {
    vi.mocked(loadConfig).mockResolvedValue(planned('plan-root'))
    const {result} = mount()
    await waitFor(() => expect(result.current.configLoaded).toBe(true))

    let release: (value: ReturnType<typeof planned>) => void = () => {}
    vi.mocked(loadConfig).mockReturnValue(new Promise(resolve => { release = resolve }))
    act(() => { result.current.reload() })

    expect(result.current.configLoaded).toBe(false)
    await act(async () => { release(planned('plan-root-2')) })
    expect(result.current.configLoaded).toBe(true)
    expect(result.current.planRootId).toBe('plan-root-2')
  })
})

describe('a plan read that fails after one that succeeded', () => {
  it('keeps the plan it already has rather than falling back to the defaults', async () => {
    // The config is deliberately NOT reset. Throwing away real plan blocks
    // over what is usually a transient read means the next tap derives
    // name-keyed ids for entries that already exist under plan-keyed ones.
    vi.mocked(loadConfig).mockResolvedValue(planned('plan-root'))
    const {result} = mount()
    await waitFor(() => expect(result.current.configLoaded).toBe(true))

    vi.mocked(loadConfig).mockRejectedValue(new Error('outline unreadable'))
    act(() => { result.current.reload() })
    await waitFor(() => expect(result.current.configLoaded).toBe(true))

    expect(result.current.planRootId).toBe('plan-root')
    expect(result.current.config.dayRolloverHour).toBe(4)
  })

  it('says the copy is stale, not that it is showing the defaults', async () => {
    // Two different situations, and the user is about to record a session
    // against one of them. "Showing the built-in defaults" would simply be
    // false here.
    vi.mocked(loadConfig).mockResolvedValue(planned('plan-root'))
    const {result} = mount()
    await waitFor(() => expect(result.current.configLoaded).toBe(true))

    vi.mocked(loadConfig).mockRejectedValue(new Error('outline unreadable'))
    act(() => { result.current.reload() })
    await waitFor(() => expect(result.current.warnings.length).toBeGreaterThan(0))

    expect(result.current.warnings.join(' ')).toContain('still using the copy read earlier')
    expect(result.current.warnings.join(' ')).not.toContain('built-in defaults')
  })
})

describe('switching an or-group', () => {
  it('locks writing before the preference write lands, not when the reload starts', async () => {
    // In the gap between the tap and the reload the OLD card is still on
    // screen and still writable, and a quick tap there materialized the
    // option the user had just switched away from — leaving an extra lift in
    // the session.
    vi.mocked(loadConfig).mockResolvedValue(planned('plan-root'))
    const {result} = mount()
    await waitFor(() => expect(result.current.configLoaded).toBe(true))

    let landed: () => void = () => {}
    vi.mocked(writeAltChoice).mockReturnValue(new Promise(resolve => { landed = () => resolve(undefined) }))
    act(() => { result.current.setAltChoice('group-1', 'option-b', 'Incline press') })

    expect(result.current.configLoaded).toBe(false)
    await act(async () => { landed() })
  })

  it('unlocks again when the preference write fails, rather than stranding the card', async () => {
    // The switch never happened, so what is on screen is still the right
    // thing to log against.
    vi.mocked(loadConfig).mockResolvedValue(planned('plan-root'))
    const {result} = mount()
    await waitFor(() => expect(result.current.configLoaded).toBe(true))

    vi.mocked(writeAltChoice).mockRejectedValue(new Error('write failed'))
    act(() => { result.current.setAltChoice('group-1', 'option-b', 'Incline press') })

    await waitFor(() => expect(result.current.configLoaded).toBe(true))
  })
})

describe('liveLoaded', () => {
  it('tells an unanswered query apart from one that answered with nothing', async () => {
    // The distinction `useHandle` exists for. Collapsed to `[]`, a query that
    // has not resolved is indistinguishable from a lift whose sets were all
    // deleted — and the logging view treats the second as news.
    vi.mocked(loadConfig).mockResolvedValue(planned('plan-root'))
    const {result} = mount()

    expect(result.current.liveLoaded).toBe(false)
    expect(result.current.liveWorkouts).toEqual([])

    await act(async () => { publishTree([]) })

    expect(result.current.liveLoaded).toBe(true)
    expect(result.current.liveWorkouts).toEqual([])
  })
})

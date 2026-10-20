import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo'
import type { BundleFolder } from '@/sync/conversion/bundle/bundleParts'
import type { ConversionUi } from '@/sync/conversion/runConversion'
import { exportRawSqliteDbToFile } from '@/utils/exportSqliteDb'
import { conversionSetup } from './conversionFlowDeps'

const h = vi.hoisted(() => ({
  io: {
    readObject: () => new Promise<never>(() => {}),
    mediaHashOf: () => 'sha256:x',
  },
}))
vi.mock('@/services/supabase', () => ({supabase: {}}))
vi.mock('@/sync/conversion/runLock', () => ({webConversionLock: () => ({})}))
vi.mock('@/utils/exportSqliteDb', () => ({exportRawSqliteDbToFile: vi.fn(), localDbFileBytes: vi.fn()}))
vi.mock('@/data/attachmentCleanerIOVerb', () => ({attachmentCleanerIOVerb: {run: async () => ({kind: 'ready', io: h.io})}}))
vi.mock('@/data/workspaceConversion', async orig => ({
  ...(await orig<typeof import('@/data/workspaceConversion')>()),
  fetchWorkspaceConversionState: () => new Promise<never>(() => {}),
}))

const depsFor = async (signal: AbortSignal) => {
  const setup = await conversionSetup({user: {id: 'user-1'}, facetRuntime: {}} as unknown as Repo, 'ws', false)
  if (setup.kind !== 'ready') throw new Error(`setup: ${setup.kind}`)
  return setup.makeDeps({} as ConversionUi, signal)
}

/** Whether `promise` has settled, polled. */
const settledFlag = (promise: Promise<unknown>) => {
  const flag = {settled: false}
  void promise.catch(() => {}).finally(() => { flag.settled = true })
  return flag
}

describe('conversionFlowDeps', () => {
  it('stops opening the database copy in a bundle folder that stopped answering', async () => {
    const deps = await depsFor(new AbortController().signal)
    const folder = {getFileHandle: () => new Promise<never>(() => {})} as unknown as BundleFolder
    const stop = new AbortController()

    const writing = deps.writeLocalDb(folder, stop.signal)
    const flag = settledFlag(writing)
    stop.abort(new DOMException('stopped', 'AbortError'))

    await vi.waitFor(() => expect(flag.settled).toBe(true))
    await expect(writing).rejects.toThrow('stopped')
    expect(exportRawSqliteDbToFile).not.toHaveBeenCalled()
  })

  it("ends the run's stalled attachment calls and stage reads when it stops", async () => {
    const run = new AbortController()
    const deps = await depsFor(run.signal)

    const calls = [deps.attachments.readObject('ws/a'), deps.fetchConversionState()]
    const flags = calls.map(settledFlag)
    // A call that answers at once still answers with its value.
    expect(deps.attachments.mediaHashOf('{}')).toBe('sha256:x')
    run.abort(new DOMException('stopped', 'AbortError'))

    await vi.waitFor(() => expect(flags.every(flag => flag.settled)).toBe(true))
    for (const call of calls) await expect(call).rejects.toThrow('stopped')
  })
})

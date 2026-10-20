import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo'
import type { BundleFolder } from '@/sync/conversion/bundle/bundleParts'
import type { ConversionUi } from '@/sync/conversion/runConversion'
import { exportRawSqliteDbToFile } from '@/utils/exportSqliteDb'
import { conversionSetup } from './conversionFlowDeps'

vi.mock('@/services/supabase', () => ({supabase: {}}))
vi.mock('@/sync/conversion/runLock', () => ({webConversionLock: () => ({})}))
vi.mock('@/utils/exportSqliteDb', () => ({exportRawSqliteDbToFile: vi.fn(), localDbFileBytes: vi.fn()}))
vi.mock('@/data/attachmentCleanerIOVerb', () => ({attachmentCleanerIOVerb: {run: async () => ({kind: 'ready', io: {}})}}))

describe('conversionFlowDeps', () => {
  it('stops opening the database copy in a bundle folder that stopped answering', async () => {
    const run = new AbortController()
    const setup = await conversionSetup({user: {id: 'user-1'}, facetRuntime: {}} as unknown as Repo, 'ws', false)
    if (setup.kind !== 'ready') throw new Error(`setup: ${setup.kind}`)
    const deps = setup.makeDeps({} as ConversionUi, run.signal)
    const folder = {getFileHandle: () => new Promise<never>(() => {})} as unknown as BundleFolder
    const stop = new AbortController()

    const writing = deps.writeLocalDb(folder, stop.signal)
    let settled = false
    void writing.catch(() => {}).finally(() => { settled = true })
    stop.abort(new DOMException('stopped', 'AbortError'))

    await vi.waitFor(() => expect(settled).toBe(true))
    await expect(writing).rejects.toThrow('stopped')
    expect(exportRawSqliteDbToFile).not.toHaveBeenCalled()
  })
})

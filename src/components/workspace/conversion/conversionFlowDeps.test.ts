import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo'
import type { BundleFolder } from '@/sync/conversion/bundle/bundleParts'
import type { ConversionAttachmentsIO } from '@/sync/conversion/conversionAttachments'
import type { ConversionUi } from '@/sync/conversion/runConversion'
import { exportRawSqliteDbToFile } from '@/utils/exportSqliteDb'
import { conversionSetup } from './conversionFlowDeps'

const h = vi.hoisted(() => {
  const stalled = () => new Promise<never>(() => {})
  /** Every member of the attachments IO: a call that never answers, except
   *  `mediaHashOf`, which answers at once. Typed over the interface, so a
   *  member added to it doesn't compile here until it's listed. */
  const io: ConversionAttachmentsIO = {
    listObjects: stalled,
    readObject: stalled,
    writeObject: stalled,
    deleteObject: stalled,
    mediaBlocks: stalled,
    readLocal: stalled,
    writeLocal: stalled,
    pendingUploads: stalled,
    mediaHashOf: () => 'sha256:x',
  }
  return {io}
})
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

  it("ends every call on the attachments IO, and the stage read, when the run stops", async () => {
    const run = new AbortController()
    const deps = await depsFor(run.signal)

    const answers = (Object.keys(h.io) as (keyof ConversionAttachmentsIO)[])
      .map(member => [member, (deps.attachments[member] as () => unknown)()] as const)
    // A call that answers at once still answers with its value.
    expect(answers.filter(([, answer]) => !(answer instanceof Promise))).toEqual([['mediaHashOf', 'sha256:x']])
    const waits = [
      ...answers.filter((entry): entry is readonly [keyof ConversionAttachmentsIO, Promise<unknown>] => entry[1] instanceof Promise),
      ['fetchConversionState', deps.fetchConversionState()] as const,
    ]
    const flags = waits.map(([, wait]) => settledFlag(wait))
    run.abort(new DOMException('stopped', 'AbortError'))

    await vi.waitFor(() => expect(flags.every(flag => flag.settled)).toBe(true))
    for (const [member, wait] of waits) await expect(wait, member).rejects.toThrow('stopped')
  })
})

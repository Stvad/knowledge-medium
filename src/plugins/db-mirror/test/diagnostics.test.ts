// @vitest-environment node
import {describe, expect, it} from 'vitest'
import {dbMirrorDiagnostic} from '../diagnostics.js'
import {DB_MIRROR_DEFAULTS, type DbMirrorState} from '../store.js'

const directory = {kind: 'directory', name: 'Backups'} as unknown as FileSystemDirectoryHandle

const state = (over: Partial<DbMirrorState> = {}): DbMirrorState => ({
  settings: {...DB_MIRROR_DEFAULTS, enabled: true},
  status: {},
  directory,
  ...over,
})

/** The two signals beside the stored state default to "nothing wrong", so a
 *  test states only the one it is about. */
const diagnose = (
  value: DbMirrorState | null,
  over: {runtimeFailure?: string; stalled?: boolean} = {},
) => dbMirrorDiagnostic(value, over.runtimeFailure, over.stalled ?? false)

describe('the mirror diagnostic', () => {
  it('says nothing before the state has loaded', () => {
    expect(diagnose(null)).toBeNull()
  })

  it('says nothing while mirroring is off — the default is not a health signal', () => {
    expect(diagnose(state({settings: DB_MIRROR_DEFAULTS}))).toBeNull()
  })

  it('nudges when the folder permission is gone, and points at the settings', () => {
    const snapshot = diagnose(
      state({status: {permissionLost: true, lastError: 'the grant lapsed'}}),
    )
    expect(snapshot).toMatchObject({
      severity: 'warning',
      nudge: true,
      // The actionable message wins over the failure text recorded by the same
      // run, which would otherwise say the same thing less usefully.
      summary: 'Database mirror is paused',
      detail: 'the grant lapsed',
      actionId: 'open_db_mirror_settings',
    })
  })

  it('nudges when mirroring is on with no folder on this device', () => {
    expect(diagnose(state({directory: undefined}))).toMatchObject({
      severity: 'warning',
      nudge: true,
    })
  })

  it('nudges about the last failure', () => {
    expect(diagnose(state({status: {lastError: 'The disk is full'}}))).toMatchObject({
      severity: 'warning',
      detail: 'The disk is full',
      nudge: true,
    })
  })

  it('does not call it healthy before the first copy exists', () => {
    // Runs wait for a genuinely idle main thread with no deadline, so this can
    // hold for a whole busy session after the user turns it on.
    const snapshot = diagnose(state())
    expect(snapshot).toMatchObject({severity: 'warning'})
    // No ambient dot: it is the ordinary state for the first few minutes.
    expect(snapshot?.nudge).toBeUndefined()
  })

  it('reports a healthy mirror without a nudge', () => {
    const snapshot = diagnose(state({status: {lastMirrorAt: Date.now()}}))
    expect(snapshot).toMatchObject({severity: 'ok'})
    expect(snapshot?.nudge).toBeUndefined()
  })

  it('reports a failure the store itself was too broken to record', () => {
    // A run that cannot READ its settings cannot write that it could not — the
    // write goes through the same broken store. Without the in-memory channel
    // the last good record stands and the chip calls the mirror healthy while
    // nothing at all is being copied.
    expect(diagnose(state({status: {lastMirrorAt: Date.now()}}), {
      runtimeFailure: 'could not open the settings database',
    })).toMatchObject({
      severity: 'warning',
      detail: 'could not open the settings database',
      nudge: true,
    })
  })

  it('prefers the recorded failure, which has a timestamp behind it', () => {
    expect(diagnose(state({status: {lastError: 'The disk is full'}}), {
      runtimeFailure: 'something in memory',
    })?.detail).toBe('The disk is full')
  })

  it('stops calling it healthy once no run has completed for several intervals', () => {
    // The tab has not been idle long enough to copy since well before the
    // cadence asked it to. Every stored field still holds the last good run's
    // values, so nothing but the clock can see this.
    const snapshot = diagnose(state({status: {lastMirrorAt: Date.now()}}), {stalled: true})
    expect(snapshot).toMatchObject({severity: 'warning', nudge: true})
    expect(snapshot?.summary).toBe('Database mirror has not run recently')
  })

  it('says the first copy is still pending rather than calling that a stall', () => {
    // Turned on moments ago in a busy session: there is nothing to be stale
    // relative to, and the more specific message is the useful one.
    expect(diagnose(state(), {stalled: true})?.summary).toBe(
      'Database mirror has not copied yet',
    )
  })
})

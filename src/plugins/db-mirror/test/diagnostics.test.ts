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

describe('the mirror diagnostic', () => {
  it('says nothing before the state has loaded', () => {
    expect(dbMirrorDiagnostic(null)).toBeNull()
  })

  it('says nothing while mirroring is off — the default is not a health signal', () => {
    expect(dbMirrorDiagnostic(state({settings: DB_MIRROR_DEFAULTS}))).toBeNull()
  })

  it('nudges when the folder permission is gone, and points at the settings', () => {
    const snapshot = dbMirrorDiagnostic(
      state({status: {permissionLost: true, lastError: 'the grant lapsed'}}),
    )
    expect(snapshot).toMatchObject({
      severity: 'warning',
      nudge: true,
      detail: 'the grant lapsed',
      actionId: 'open_db_mirror_settings',
    })
  })

  it('nudges when mirroring is on with no folder on this device', () => {
    expect(dbMirrorDiagnostic(state({directory: undefined}))).toMatchObject({
      severity: 'warning',
      nudge: true,
    })
  })

  it('nudges about the last failure', () => {
    expect(dbMirrorDiagnostic(state({status: {lastError: 'The disk is full'}}))).toMatchObject({
      severity: 'warning',
      detail: 'The disk is full',
      nudge: true,
    })
  })

  it('does not call it healthy before the first copy exists', () => {
    // Runs wait for a genuinely idle main thread with no deadline, so this can
    // hold for a whole busy session after the user turns it on.
    const snapshot = dbMirrorDiagnostic(state())
    expect(snapshot).toMatchObject({severity: 'warning'})
    // No ambient dot: it is the ordinary state for the first few minutes.
    expect(snapshot?.nudge).toBeUndefined()
  })

  it('reports a healthy mirror without a nudge', () => {
    const snapshot = dbMirrorDiagnostic(state({status: {lastMirrorAt: Date.now()}}))
    expect(snapshot).toMatchObject({severity: 'ok'})
    expect(snapshot?.nudge).toBeUndefined()
  })

  it('prefers the paused message over a stale failure from the same run', () => {
    // A lapsed grant records BOTH flags; only the actionable one should show.
    const snapshot = dbMirrorDiagnostic(
      state({status: {permissionLost: true, lastError: 'permission text'}}),
    )
    expect(snapshot?.summary).toBe('Database mirror is paused')
  })
})

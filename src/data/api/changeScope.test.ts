import { describe, expect, it } from 'vitest'
import {
  ChangeScope,
  scopeAllowedInReadOnly,
  scopeIsUndoable,
  scopeUploadsToServer,
  sourceForScope,
} from './changeScope'

describe('change scope policies', () => {
  // The "every scope is in the policy table" invariant is enforced at
  // compile time by `CHANGE_SCOPE_POLICIES satisfies Readonly<Record<
  // ChangeScope, ChangeScopePolicy>>` — a runtime restatement can't catch
  // anything the type checker doesn't already reject.

  it('routes every writable scope through source="user"', () => {
    // Every repo.tx invocation queues to ps_crud now; UI-state used to
    // route to a 'local-ephemeral' sink that never uploaded. The
    // rejection quarantine ([[feedback_powersync_sync_config_with_schema]])
    // is what catches RLS / FK failures, so there's no need for a
    // separate non-uploading source.
    expect(sourceForScope(ChangeScope.BlockDefault)).toBe('user')
    expect(sourceForScope(ChangeScope.References)).toBe('user')
    expect(sourceForScope(ChangeScope.UserPrefs)).toBe('user')
    expect(sourceForScope(ChangeScope.UiState)).toBe('user')
    expect(sourceForScope(ChangeScope.Automation)).toBe('user')
  })

  it('every writable scope uploads to the server', () => {
    expect(scopeUploadsToServer(ChangeScope.BlockDefault)).toBe(true)
    expect(scopeUploadsToServer(ChangeScope.References)).toBe(true)
    expect(scopeUploadsToServer(ChangeScope.UserPrefs)).toBe(true)
    expect(scopeUploadsToServer(ChangeScope.UiState)).toBe(true)
    expect(scopeUploadsToServer(ChangeScope.Automation)).toBe(true)
  })

  it('read-only mode rejects document edits and allows UI/prefs/automation writes', () => {
    // UserPrefs, UiState, and Automation writes still happen locally and queue to
    // ps_crud in read-only mode. The server will refuse them and the
    // rejection-quarantine surface lets the user see the noise.
    expect(scopeAllowedInReadOnly(ChangeScope.BlockDefault)).toBe(false)
    expect(scopeAllowedInReadOnly(ChangeScope.References)).toBe(false)
    expect(scopeAllowedInReadOnly(ChangeScope.UiState)).toBe(true)
    expect(scopeAllowedInReadOnly(ChangeScope.UserPrefs)).toBe(true)
    expect(scopeAllowedInReadOnly(ChangeScope.Automation)).toBe(true)
  })

  it('centralizes undo behavior', () => {
    expect(scopeIsUndoable(ChangeScope.BlockDefault)).toBe(true)
    expect(scopeIsUndoable(ChangeScope.References)).toBe(true)
    expect(scopeIsUndoable(ChangeScope.UiState)).toBe(false)
    expect(scopeIsUndoable(ChangeScope.UserPrefs)).toBe(false)
    expect(scopeIsUndoable(ChangeScope.Automation)).toBe(false)
  })
})

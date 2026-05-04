import { describe, expect, it } from 'vitest'
import {
  CHANGE_SCOPE_POLICIES,
  ChangeScope,
  scopeAllowedInReadOnly,
  scopeIsUndoable,
  scopeUploadsToServer,
  sourceForScope,
} from './changeScope'

describe('change scope policies', () => {
  it('defines every scope in the policy table', () => {
    expect(Object.keys(CHANGE_SCOPE_POLICIES).sort()).toEqual(Object.values(ChangeScope).sort())
  })

  it('routes writable scopes to their configured source', () => {
    expect(sourceForScope(ChangeScope.BlockDefault)).toBe('user')
    expect(sourceForScope(ChangeScope.References)).toBe('user')
    expect(sourceForScope(ChangeScope.UserPrefs)).toBe('user')
    expect(sourceForScope(ChangeScope.UiState)).toBe('local-ephemeral')
  })

  it('downgrades only UserPrefs to local-ephemeral in read-only mode', () => {
    expect(sourceForScope(ChangeScope.UserPrefs, {isReadOnly: true})).toBe('local-ephemeral')
    expect(scopeUploadsToServer(ChangeScope.UserPrefs)).toBe(true)
    expect(scopeUploadsToServer(ChangeScope.UserPrefs, {isReadOnly: true})).toBe(false)
  })

  it('centralizes read-only and undo behavior', () => {
    expect(scopeAllowedInReadOnly(ChangeScope.BlockDefault)).toBe(false)
    expect(scopeAllowedInReadOnly(ChangeScope.References)).toBe(false)
    expect(scopeAllowedInReadOnly(ChangeScope.UiState)).toBe(true)
    expect(scopeAllowedInReadOnly(ChangeScope.UserPrefs)).toBe(true)

    expect(scopeIsUndoable(ChangeScope.BlockDefault)).toBe(true)
    expect(scopeIsUndoable(ChangeScope.References)).toBe(true)
    expect(scopeIsUndoable(ChangeScope.UiState)).toBe(false)
    expect(scopeIsUndoable(ChangeScope.UserPrefs)).toBe(false)
  })
})

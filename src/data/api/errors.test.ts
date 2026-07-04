import { describe, expect, it } from 'vitest'
import * as errorsModule from './errors'
import {
  BlockNotFoundError,
  BlockNotLoadedError,
  CodecError,
  CycleError,
  DataLayerError,
  DeletedConflictError,
  DeterministicIdCrossWorkspaceError,
  DuplicateIdError,
  MergeIntoDescendantError,
  MutatorNotRegisteredError,
  NotDeletedError,
  ParentDeletedError,
  ParentNotFoundError,
  ParentWorkspaceMismatchError,
  ProcessorNotRegisteredError,
  QueryNotRegisteredError,
  ReadOnlyError,
  WorkspaceMismatchError,
  WorkspaceNotPinnedError,
} from './errors'

describe('data-layer errors', () => {
  it('all subclass DataLayerError so callers can broad-catch', () => {
    const errors = [
      new BlockNotFoundError('a'),
      new BlockNotLoadedError('a'),
      new CycleError('a', 'b'),
      new DeletedConflictError('a'),
      new DeterministicIdCrossWorkspaceError('a', 'w1', 'w2'),
      new DuplicateIdError('a'),
      new MergeIntoDescendantError('into', 'from'),
      new MutatorNotRegisteredError('m'),
      new NotDeletedError('a'),
      new ParentDeletedError('p'),
      new ParentNotFoundError('p'),
      new ParentWorkspaceMismatchError('p', 'wa', 'wb'),
      new ProcessorNotRegisteredError('p'),
      new QueryNotRegisteredError('q'),
      new ReadOnlyError('block-default'),
      new WorkspaceMismatchError('w1', 'w2'),
      new WorkspaceNotPinnedError(),
    ]
    for (const e of errors) {
      expect(e).toBeInstanceOf(DataLayerError)
      expect(e).toBeInstanceOf(Error)
      expect(e.name).toBe(e.constructor.name)
    }
  })

  it('every error reports a stable class name that survives minification', () => {
    // The base sets no `new.target.name` (OXC minification strips class names, so
    // it would yield a mangled id at runtime); each error pins `name` to a string
    // literal in errors.ts. Assert every exported DataLayerError reports its
    // export name, so a newly-added error that forgets its entry fails HERE
    // rather than shipping a garbage `name` to prod logs.
    const exports = Object.entries(errorsModule) as ReadonlyArray<[string, unknown]>
    let checked = 0
    for (const [exportName, value] of exports) {
      if (typeof value !== 'function') continue
      const proto = (value as {prototype?: unknown}).prototype
      if (proto !== DataLayerError.prototype && !(proto instanceof DataLayerError)) continue
      expect((proto as {name?: unknown}).name, exportName).toBe(exportName)
      checked++
    }
    // Guard against the loop silently matching nothing (e.g. a bad predicate).
    expect(checked).toBeGreaterThan(15)
  })

  it('CodecError also subclasses DataLayerError', () => {
    expect(new CodecError('string', 42)).toBeInstanceOf(DataLayerError)
  })

  it('preserves identifying fields on tree errors', () => {
    const cyc = new CycleError('child', 'newParent')
    expect(cyc.movedId).toBe('child')
    expect(cyc.targetParentId).toBe('newParent')

    const merge = new MergeIntoDescendantError('intoX', 'fromY')
    expect(merge.intoId).toBe('intoX')
    expect(merge.fromId).toBe('fromY')
    expect(merge.message).toContain('intoX')
    expect(merge.message).toContain('fromY')

    const cross = new DeterministicIdCrossWorkspaceError('id', 'wa', 'wb')
    expect(cross.id).toBe('id')
    expect(cross.existingWorkspaceId).toBe('wa')
    expect(cross.requestedWorkspaceId).toBe('wb')

    const mismatch = new WorkspaceMismatchError('w1', 'w2')
    expect(mismatch.pinnedWorkspaceId).toBe('w1')
    expect(mismatch.attemptedWorkspaceId).toBe('w2')
  })

  it('messages include the relevant identifiers for grep-friendly logs', () => {
    expect(new ParentNotFoundError('parentX').message).toContain('parentX')
    expect(new ReadOnlyError('block-default').message).toContain('block-default')
  })
})

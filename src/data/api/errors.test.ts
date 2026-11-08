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
      new CodecError('string', 42),
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

  it('messages include the relevant identifiers for grep-friendly logs', () => {
    expect(new ParentNotFoundError('parentX').message).toContain('parentX')
    expect(new ReadOnlyError('block-default').message).toContain('block-default')
    const merge = new MergeIntoDescendantError('intoX', 'fromY').message
    expect(merge).toContain('intoX')
    expect(merge).toContain('fromY')
  })
})

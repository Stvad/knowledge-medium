import { describe, expect, it } from 'vitest'
import {
  BlockNotFoundError,
  BlockNotLoadedError,
  CodecError,
  CycleError,
  DataLayerError,
  DeletedConflictError,
  DeterministicIdCrossWorkspaceError,
  DuplicateIdError,
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

  it('CodecError also subclasses DataLayerError', () => {
    expect(new CodecError('string', 42)).toBeInstanceOf(DataLayerError)
  })

  it('preserves identifying fields on tree errors', () => {
    const cyc = new CycleError('child', 'newParent')
    expect(cyc.movedId).toBe('child')
    expect(cyc.targetParentId).toBe('newParent')

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

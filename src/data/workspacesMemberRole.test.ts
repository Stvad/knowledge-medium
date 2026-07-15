// @vitest-environment node
import {describe, expect, it, vi} from 'vitest'
import type {Repo} from '@/data/repo'
import {awaitLocalMemberRole} from '@/data/workspaces'

interface ChangeHandler {
  onChange: () => void | Promise<void>
  onError?: (error: unknown) => void
}

class MemberRoleDbFake {
  role: string | null = null
  queryError: unknown = null
  subscribeError: unknown = null
  onSubscribe: (() => void) | null = null
  handler: ChangeHandler | null = null
  disposeError: unknown = null
  readonly dispose = vi.fn(() => {
    if (this.disposeError) throw this.disposeError
  })
  readonly getOptional = vi.fn(async () => {
    if (this.queryError) throw this.queryError
    return this.role === null ? null : {role: this.role}
  })

  onChange(handler: ChangeHandler, options?: {tables?: readonly string[]}): () => void {
    if (this.subscribeError) throw this.subscribeError
    expect(options?.tables).toEqual(['workspace_members'])
    this.handler = handler
    this.onSubscribe?.()
    return this.dispose
  }

  repo(): Repo {
    return {db: this} as unknown as Repo
  }
}

describe('awaitLocalMemberRole', () => {
  it('returns an already-local role without subscribing', async () => {
    const db = new MemberRoleDbFake()
    db.role = 'owner'
    const onChange = vi.spyOn(db, 'onChange')

    await expect(awaitLocalMemberRole(db.repo(), 'ws', 'user')).resolves.toBe('owner')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('closes the query-before-listener race with a post-subscription recheck', async () => {
    const db = new MemberRoleDbFake()
    db.onSubscribe = () => { db.role = 'editor' }

    await expect(awaitLocalMemberRole(db.repo(), 'ws', 'user')).resolves.toBe('editor')
    expect(db.getOptional).toHaveBeenCalledTimes(2)
    expect(db.dispose).toHaveBeenCalledTimes(1)
  })

  it('waits for a matching role change, then resolves and disposes once', async () => {
    const db = new MemberRoleDbFake()
    let settled = false
    const waiting = awaitLocalMemberRole(db.repo(), 'ws', 'user').then(role => {
      settled = true
      return role
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    // A table change without the target membership remains parked.
    await db.handler!.onChange()
    expect(settled).toBe(false)

    db.role = 'viewer'
    await db.handler!.onChange()
    await expect(waiting).resolves.toBe('viewer')
    expect(db.dispose).toHaveBeenCalledTimes(1)
  })

  it('rejects and disposes on recheck or subscription errors', async () => {
    const queryDb = new MemberRoleDbFake()
    const queryWaiting = awaitLocalMemberRole(queryDb.repo(), 'ws', 'user')
    await Promise.resolve()
    await Promise.resolve()
    queryDb.queryError = new Error('query failed')
    await queryDb.handler!.onChange()
    await expect(queryWaiting).rejects.toThrow('query failed')
    expect(queryDb.dispose).toHaveBeenCalledTimes(1)

    const subscriptionDb = new MemberRoleDbFake()
    subscriptionDb.subscribeError = new Error('subscription failed')
    await expect(awaitLocalMemberRole(subscriptionDb.repo(), 'ws', 'user'))
      .rejects.toThrow('subscription failed')
    expect(subscriptionDb.dispose).not.toHaveBeenCalled()
  })

  it('rejects DB subscription errors and disposes', async () => {
    const db = new MemberRoleDbFake()
    const waiting = awaitLocalMemberRole(db.repo(), 'ws', 'user')
    await Promise.resolve()
    await Promise.resolve()
    db.handler!.onError?.(new Error('stream failed'))

    await expect(waiting).rejects.toThrow('stream failed')
    expect(db.dispose).toHaveBeenCalledTimes(1)
  })

  it('rejects instead of hanging when successful cleanup throws', async () => {
    const db = new MemberRoleDbFake()
    const waiting = awaitLocalMemberRole(db.repo(), 'ws', 'user')
    await Promise.resolve()
    await Promise.resolve()
    db.disposeError = new Error('dispose failed')
    db.role = 'editor'
    await db.handler!.onChange()

    await expect(waiting).rejects.toThrow('dispose failed')
    expect(db.dispose).toHaveBeenCalledTimes(1)
  })

  it('supports already-aborted and later-aborted waits', async () => {
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    const untouched = new MemberRoleDbFake()
    await expect(awaitLocalMemberRole(untouched.repo(), 'ws', 'user', {
      signal: alreadyAborted.signal,
    })).rejects.toMatchObject({name: 'AbortError'})
    expect(untouched.getOptional).not.toHaveBeenCalled()

    const controller = new AbortController()
    const db = new MemberRoleDbFake()
    const waiting = awaitLocalMemberRole(db.repo(), 'ws', 'user', {
      signal: controller.signal,
    })
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()

    await expect(waiting).rejects.toMatchObject({name: 'AbortError'})
    expect(db.dispose).toHaveBeenCalledTimes(1)
  })
})

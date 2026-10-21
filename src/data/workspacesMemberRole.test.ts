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

  // A caller inside a `PendingIdleJobs` job passes its `ParkHandle` here so the
  // drain barrier can tell "blocked on a row only sync delivers" from "working"
  // (issue #1015). The region has to cover the SUBSCRIPTION wait and nothing
  // else, or a drain stops waiting on a pass that is about to run.
  // 39ms of work for the whole file — the budget is for the 5s polls below, which
  // vitest's 5s default would expire alongside rather than after.
  describe('park accounting', {timeout: 20_000}, () => {
    /** Net open regions, which is the invariant — a call count would pin how many
     *  times the wait happens to lift and re-enter its park, which is a detail of
     *  how rechecks arrive. */
    const parkSpy = () => {
      let depth = 0
      // No idempotency guard, deliberately: `unpark` drops its release the moment
      // it calls it, so a doubled release would be a bug, and an unguarded double
      // shows up as a negative depth instead of being absorbed here.
      const onPark = vi.fn(() => {
        depth += 1
        return () => { depth -= 1 }
      })
      return {onPark, depth: () => depth}
    }

    /** The subscription is installed and its post-subscribe recheck has settled. */
    const parked = (park: {depth: () => number}): Promise<void> =>
      vi.waitFor(() => expect(park.depth()).toBe(1), {timeout: 5_000, interval: 5})

    it('does not park when the role is already local', async () => {
      const db = new MemberRoleDbFake()
      db.role = 'owner'
      const park = parkSpy()

      await expect(awaitLocalMemberRole(db.repo(), 'ws', 'user', {onPark: park.onPark}))
        .resolves.toBe('owner')
      expect(park.onPark).not.toHaveBeenCalled()
    })

    it('parks for the subscription wait and releases when the row arrives', async () => {
      const db = new MemberRoleDbFake()
      const park = parkSpy()
      const waiting = awaitLocalMemberRole(db.repo(), 'ws', 'user', {onPark: park.onPark})
      await parked(park)

      db.role = 'editor'
      await db.handler!.onChange()
      await expect(waiting).resolves.toBe('editor')
      expect(park.depth()).toBe(0)
    })

    // A wake-up runs a bounded LOCAL read. Holding the park across it tells a
    // concurrent drain the job is externally blocked when it is about to write:
    // the drain returns, then the recheck finds the row and the pass runs on.
    it('lifts the park while a wake-up recheck runs, and re-enters if the row is still absent', async () => {
      const db = new MemberRoleDbFake()
      const park = parkSpy()
      const waiting = awaitLocalMemberRole(db.repo(), 'ws', 'user', {onPark: park.onPark})
      await parked(park)

      let finishQuery!: () => void
      const query = new Promise<void>(resolve => { finishQuery = resolve })
      db.getOptional.mockImplementationOnce(async () => { await query; return null })
      const recheck = db.handler!.onChange()
      await vi.waitFor(() => expect(park.depth()).toBe(0), {timeout: 5_000, interval: 5})

      finishQuery()
      await recheck
      expect(park.depth()).toBe(1)

      db.role = 'editor'
      await db.handler!.onChange()
      await expect(waiting).resolves.toBe('editor')
      expect(park.depth()).toBe(0)
    })

    // The LAST recheck out re-enters the park. Re-entering per check would put it
    // back while the overlapping read was still running — the state the test
    // above proves is wrong, at a second position.
    it('stays unparked until the last of several overlapping rechecks finishes', async () => {
      const db = new MemberRoleDbFake()
      const park = parkSpy()
      const waiting = awaitLocalMemberRole(db.repo(), 'ws', 'user', {onPark: park.onPark})
      await parked(park)

      let finishFirst!: () => void
      let finishSecond!: () => void
      const first = new Promise<void>(resolve => { finishFirst = resolve })
      const second = new Promise<void>(resolve => { finishSecond = resolve })
      db.getOptional
        .mockImplementationOnce(async () => { await first; return null })
        .mockImplementationOnce(async () => { await second; return null })
      const firstCheck = db.handler!.onChange()
      const secondCheck = db.handler!.onChange()
      await vi.waitFor(() => expect(park.depth()).toBe(0), {timeout: 5_000, interval: 5})

      finishFirst()
      await firstCheck
      expect(park.depth()).toBe(0)

      finishSecond()
      await secondCheck
      expect(park.depth()).toBe(1)

      db.role = 'editor'
      await db.handler!.onChange()
      await expect(waiting).resolves.toBe('editor')
      expect(park.depth()).toBe(0)
    })

    // SYNCHRONOUSLY, with no await in between: `endTestRepoScope` unpins (which
    // aborts this wait) and drains in the same turn, and a release deferred to
    // the job's own unwinding would leave that drain skipping a job still on its
    // way out — the cross-test write #813 exists to stop.
    it('releases the park in the same turn as the abort', async () => {
      const controller = new AbortController()
      const db = new MemberRoleDbFake()
      const park = parkSpy()
      const waiting = awaitLocalMemberRole(db.repo(), 'ws', 'user', {
        signal: controller.signal,
        onPark: park.onPark,
      })
      await parked(park)

      controller.abort()
      expect(park.depth()).toBe(0)
      await expect(waiting).rejects.toMatchObject({name: 'AbortError'})
    })

    it('releases the park when the wait fails', async () => {
      const db = new MemberRoleDbFake()
      const park = parkSpy()
      const waiting = awaitLocalMemberRole(db.repo(), 'ws', 'user', {onPark: park.onPark})
      await parked(park)

      db.handler!.onError?.(new Error('stream failed'))
      expect(park.depth()).toBe(0)
      await expect(waiting).rejects.toThrow('stream failed')
    })
  })
})

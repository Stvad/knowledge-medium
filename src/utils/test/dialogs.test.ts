// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetDialogsForTests,
  getDialogQueue,
  openDialog,
  subscribeDialogs,
  type DialogContextProps,
} from '../dialogs.ts'

interface Result {
  value: string
}

const TestDialog: (props: DialogContextProps<Result>) => null = () => null

afterEach(() => {
  __resetDialogsForTests()
})

describe('openDialog', () => {
  it('queues an entry and notifies subscribers when called', () => {
    const observer = vi.fn()
    const unsubscribe = subscribeDialogs(observer)
    expect(getDialogQueue()).toHaveLength(0)

    void openDialog<Result>(TestDialog)

    expect(observer).toHaveBeenCalledTimes(1)
    expect(getDialogQueue()).toHaveLength(1)
    unsubscribe()
  })

  it('passes provided props through to the queued entry', async () => {
    const observer = vi.fn()
    const unsubscribe = subscribeDialogs(observer)
    void openDialog<Result, {seed: number}>(
      TestDialog as never,
      {seed: 7},
    )

    expect(getDialogQueue()[0].props).toEqual({seed: 7})
    unsubscribe()
  })

  it('resolves with the typed value when the host calls finalize(value)', async () => {
    const promise = openDialog<Result>(TestDialog)
    const entry = getDialogQueue()[0]
    expect(entry).toBeTruthy()

    entry.finalize({value: 'ok'} satisfies Result)
    await expect(promise).resolves.toEqual({value: 'ok'})
    expect(getDialogQueue()).toHaveLength(0)
  })

  it('resolves with null when the host calls finalize(null) (cancel)', async () => {
    const promise = openDialog<Result>(TestDialog)
    const entry = getDialogQueue()[0]
    entry.finalize(null)
    await expect(promise).resolves.toBeNull()
  })

  it('serves multiple concurrent dialogs independently', async () => {
    const a = openDialog<Result>(TestDialog)
    const b = openDialog<Result>(TestDialog)
    expect(getDialogQueue()).toHaveLength(2)

    const [first, second] = getDialogQueue()
    second.finalize({value: 'second'} satisfies Result)
    first.finalize({value: 'first'} satisfies Result)

    await expect(a).resolves.toEqual({value: 'first'})
    await expect(b).resolves.toEqual({value: 'second'})
    expect(getDialogQueue()).toHaveLength(0)
  })

  it('__resetDialogsForTests drains queued promises with null', async () => {
    const promise = openDialog<Result>(TestDialog)
    expect(getDialogQueue()).toHaveLength(1)

    __resetDialogsForTests()
    await expect(promise).resolves.toBeNull()
    expect(getDialogQueue()).toHaveLength(0)
  })

  it('unsubscribe stops further notifications', () => {
    const observer = vi.fn()
    const unsubscribe = subscribeDialogs(observer)
    unsubscribe()

    void openDialog<Result>(TestDialog)
    expect(observer).not.toHaveBeenCalled()
  })
})

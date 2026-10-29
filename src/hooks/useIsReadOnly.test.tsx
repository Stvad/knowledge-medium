// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { releaseTestRepos } from '@/data/test/testRepoScope'
import type { Repo } from '@/data/repo'
import { useIsReadOnly } from './useIsReadOnly.ts'

let db: TestDb
let repo: Repo

beforeAll(async () => {
  db = await createTestDb()
  repo = createTestRepo({db: db.db, user: {id: 'user-1'}}).repo
})

afterAll(async () => {
  await releaseTestRepos([repo])
  await db.cleanup()
})

describe('useIsReadOnly', () => {
  it('follows a role change, which moves nothing else a component re-reads on', () => {
    const {result} = renderHook(() => useIsReadOnly(repo))
    expect(result.current).toBe(false)

    act(() => { repo.setReadOnly(true) })
    expect(result.current).toBe(true)

    act(() => { repo.setReadOnly(false) })
    expect(result.current).toBe(false)
  })
})

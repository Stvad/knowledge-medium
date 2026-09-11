// @vitest-environment happy-dom
/** That the opener HOOKS carry `OpenBlockContext.ensure` through to the
 *  navigation, which `openBlockFromEvent`'s own tests cannot see: both hooks sit
 *  between the caller and that function, and `useOpenBlock` used to rebuild the
 *  context field by field — silently dropping a callback it did not enumerate.
 *  A dropped `ensure` is a missing behaviour, not a type error, so it needs a
 *  render to catch. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RepoContext } from '@/context/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { useBlockOpener, useOpenBlock, type EnsureNavigationTarget } from '@/utils/navigation'

const WS = 'ws-opener'

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(() => { cleanup() })

// Isolation lives in the hook, not in `setup` — see AGENTS.md's shared-db rule.
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
})

const setup = async (): Promise<void> => {
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
  repo.setActiveWorkspaceId(WS)
}

const ViaUseOpenBlock = ({ensure}: {ensure: EnsureNavigationTarget}) => {
  const onClick = useOpenBlock({blockId: 'b-hooked', workspaceId: WS, ensure})
  return <button aria-label="open" onClick={onClick}/>
}

const ViaUseBlockOpener = ({ensure}: {ensure: EnsureNavigationTarget}) => {
  const opener = useBlockOpener()
  return <button aria-label="open" onClick={e => opener(e, {blockId: 'b-hooked', workspaceId: WS, ensure})}/>
}

describe.each([
  ['useOpenBlock', ViaUseOpenBlock],
  ['useBlockOpener', ViaUseBlockOpener],
])('%s', (_name, Surface) => {
  it('carries `ensure` through to the navigation', async () => {
    await setup()
    const ran = vi.fn()
    render(
      <RepoContext value={repo}>
        <Surface ensure={() => { ran(); return Promise.resolve() }}/>
      </RepoContext>,
    )

    fireEvent.click(screen.getByLabelText('open'))
    await vi.waitFor(() => { expect(ran).toHaveBeenCalled() })
  })
})

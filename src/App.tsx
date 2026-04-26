import { BlockComponent } from './components/BlockComponent'
import { BlockContextProvider } from '@/context/block.tsx'
import { use } from 'react'
import { getRootBlock, Block } from '@/data/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { useLocation, useSearchParam } from 'react-use'
import { getExampleBlocks } from '@/initData.ts'
import { Repo } from '@/data/repo'
import { memoize } from 'lodash'
import { importState } from '@/utils/state.ts'
import { hasRemoteSyncConfig } from '@/services/powersync.ts'
import { AppRuntimeProvider } from '@/extensions/AppRuntimeProvider.tsx'
import {
  ensurePersonalWorkspace,
  getLocalWorkspace,
  listLocalWorkspaces,
  listMyWorkspaceIdsViaRest,
  primeLocalMembership,
  primeLocalWorkspace,
} from '@/data/workspaces.ts'
import { parseAppHash, writeAppHash } from '@/utils/routing.ts'

const LAST_WORKSPACE_STORAGE_KEY = 'ftm.lastWorkspaceId'

const rememberWorkspace = (workspaceId: string) => {
  try {
    window.localStorage.setItem(LAST_WORKSPACE_STORAGE_KEY, workspaceId)
  } catch {
    // ignore (incognito, quota, etc.)
  }
}

const recallRememberedWorkspace = (): string | undefined => {
  try {
    return window.localStorage.getItem(LAST_WORKSPACE_STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

const waitForInitialRemoteSync = async (repo: Repo, timeoutMs: number) => {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  try {
    await repo.db.waitForFirstSync(controller.signal)
  } catch {
    // best-effort wait; surface no error so the bootstrap path still proceeds
  } finally {
    window.clearTimeout(timeoutId)
  }
}

// Resolve which workspace to enter.
//
// Order of preference:
//   1. Explicit workspaceId in the URL hash, but only after the server
//      confirms the current user is a member. This guards against a
//      shared/copied URL pointing at someone else's workspace, where
//      the upload queue would otherwise pile up RLS rejections.
//   2. localStorage-remembered last workspace, if it's locally available.
//   3. ensure_personal_workspace RPC, which is idempotent — returns the
//      caller's first workspace or creates one. Also primes local SQLite
//      so the workspace appears in the switcher before sync replicates.
//   4. Local fallback for the no-Supabase dev path.
const resolveWorkspaceId = async (
  repo: Repo,
  requestedWorkspaceId: string | undefined,
  useRemoteSync: boolean,
): Promise<string> => {
  if (useRemoteSync) {
    const accessibleIds = await listMyWorkspaceIdsViaRest()

    if (requestedWorkspaceId && accessibleIds.has(requestedWorkspaceId)) {
      return requestedWorkspaceId
    }

    if (requestedWorkspaceId) {
      // URL pointed at a workspace this user can't access (typical when a
      // shared link is opened in a session that isn't the original owner's).
      // Drop the requested id and bootstrap our own.
      // eslint-disable-next-line no-console
      console.warn(
        `[workspaces] URL workspace ${requestedWorkspaceId} is not accessible to ${repo.currentUser.id}; bootstrapping personal workspace`,
      )
    }

    const remembered = recallRememberedWorkspace()
    if (remembered && accessibleIds.has(remembered)) {
      return remembered
    }

    const workspace = await ensurePersonalWorkspace()
    await primeLocalWorkspace(repo, workspace)
    await primeLocalMembership(repo, {
      id: `bootstrap-${workspace.id}`,
      workspaceId: workspace.id,
      userId: repo.currentUser.id,
      role: 'owner',
      createTime: workspace.createTime,
    })
    return workspace.id
  }

  // No-Supabase dev fallback: trust local-only state.
  if (requestedWorkspaceId) {
    return requestedWorkspaceId
  }

  const remembered = recallRememberedWorkspace()
  if (remembered) {
    const ws = await getLocalWorkspace(repo, remembered)
    if (ws) return ws.id
  }

  const locals = await listLocalWorkspaces(repo)
  if (locals.length > 0) return locals[0].id

  throw new Error('No workspace available and remote sync is disabled')
}

const getInitialBlock = memoize(
  async (
    repo: Repo,
    requestedWorkspaceId: string | undefined,
    requestedBlockId: string | undefined,
    useRemoteSync: boolean,
  ): Promise<{workspaceId: string, block: Block}> => {
    const workspaceId = await resolveWorkspaceId(repo, requestedWorkspaceId, useRemoteSync)
    repo.setActiveWorkspaceId(workspaceId)
    rememberWorkspace(workspaceId)

    if (requestedBlockId && await repo.exists(requestedBlockId)) {
      const block = repo.find(requestedBlockId)
      const data = await block.data()
      if (data && data.workspaceId === workspaceId) {
        writeAppHash(workspaceId, requestedBlockId)
        return {workspaceId, block}
      }
    }

    let rootId = await repo.findFirstRootBlockId(workspaceId)

    if (!rootId && useRemoteSync) {
      await waitForInitialRemoteSync(repo, 5000)
      rootId = await repo.findFirstRootBlockId(workspaceId)
    }

    if (rootId) {
      writeAppHash(workspaceId, rootId)
      return {workspaceId, block: repo.find(rootId)}
    }

    // Empty workspace: seed the starter tree.
    const blockMap = await importState(
      {blocks: getExampleBlocks()},
      repo,
      {workspaceId},
    )
    await repo.flush()
    const block = blockMap.values().next().value!
    writeAppHash(workspaceId, block.id)
    return {workspaceId, block}
  },
  (repo, workspaceId, blockId, useRemoteSync) =>
    `${repo.instanceId}:${workspaceId ?? '__no_ws__'}:${blockId ?? '__no_block__'}:${useRemoteSync ? 'remote' : 'local'}`,
)

const App = () => {
  const repo = useRepo()
  const location = useLocation()
  const safeMode = Boolean(useSearchParam('safeMode'))

  const {workspaceId: requestedWorkspaceId, blockId: requestedBlockId} = parseAppHash(location.hash)
  const {block: handle} = use(
    getInitialBlock(repo, requestedWorkspaceId, requestedBlockId, hasRemoteSyncConfig),
  )
  const rootBlock = use(getRootBlock(repo.find(handle.id)))

  return (
    <BlockContextProvider initialValue={{rootBlockId: rootBlock.id, topLevel: true, safeMode}}>
      <AppRuntimeProvider rootBlock={rootBlock} safeMode={safeMode}>
        <BlockComponent blockId={handle.id}/>
      </AppRuntimeProvider>
    </BlockContextProvider>
  )
}

export default App

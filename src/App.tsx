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
  canAccessRemoteWorkspace,
  ensurePersonalWorkspace,
  getLocalWorkspace,
  listLocalWorkspaces,
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

// Poll local PowerSync state for the workspace's first root block. We can't
// use `db.waitForFirstSync` for this — it resolves immediately on subsequent
// sessions (persistent IndexedDB remembers first sync was already done), so
// it doesn't actually wait for *this* workspace's blocks to arrive. A small
// polling loop is crude but actually does what we need: keep checking until
// the row appears or we give up.
const pollForLocalRootBlock = async (
  repo: Repo,
  workspaceId: string,
  timeoutMs: number,
): Promise<string | undefined> => {
  const deadline = Date.now() + timeoutMs
  let rootId = await repo.findFirstRootBlockId(workspaceId)
  while (!rootId && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300))
    rootId = await repo.findFirstRootBlockId(workspaceId)
  }
  return rootId
}

// Resolve which workspace to enter.
//
// Returns a `freshlyCreated` flag so getInitialBlock can decide whether
// it's safe to seed the starter tree. Seeding is only correct when this
// run actually CREATED the workspace via ensure_personal_workspace; for
// any path where the workspace already existed (URL nav, remembered, RPC
// returned an existing row), the workspace's blocks are coming via
// PowerSync sync and we must NOT pre-empt them with a seed (which would
// create duplicate roots that then collide on the server).
const resolveWorkspaceId = async (
  repo: Repo,
  requestedWorkspaceId: string | undefined,
  useRemoteSync: boolean,
): Promise<{id: string, freshlyCreated: boolean}> => {
  if (requestedWorkspaceId) {
    // Fast path: if PowerSync has already replicated this workspace into
    // our local DB, RLS allowed it — we have access, trust the URL.
    const localWs = await getLocalWorkspace(repo, requestedWorkspaceId)
    if (localWs) return {id: localWs.id, freshlyCreated: false}

    // Slow path: not local. This could be either "we don't have access"
    // or "we have access but sync hasn't replicated yet". Ask the server
    // (RLS-gated) to disambiguate. We can't poll local sqlite for this:
    // `db.waitForFirstSync` resolves instantly on subsequent sessions
    // (persistent IndexedDB), and a missing row could legitimately mean
    // either case.
    if (useRemoteSync) {
      const hasAccess = await canAccessRemoteWorkspace(requestedWorkspaceId).catch((err) => {
        // Treat transport errors as "unknown" rather than "denied" — fall
        // through to default flow rather than misclassifying offline mode
        // as a permission denial.
        console.warn('canAccessRemoteWorkspace failed; falling back to default flow', err)
        return false
      })
      if (hasAccess) {
        // Server confirms access; getInitialBlock will poll for the blocks
        // to land via sync.
        return {id: requestedWorkspaceId, freshlyCreated: false}
      }
      console.warn(
        `Workspace ${requestedWorkspaceId} from URL is not accessible; falling back to default workspace.`,
      )
    }
    // No access (or no remote sync) — fall through to default flow. The
    // eventual writeAppHash will overwrite the bad hash.
  }

  const remembered = recallRememberedWorkspace()
  if (remembered) {
    const ws = await getLocalWorkspace(repo, remembered)
    if (ws) return {id: ws.id, freshlyCreated: false}
  }

  if (useRemoteSync) {
    const calledAt = Date.now()
    const workspace = await ensurePersonalWorkspace()
    // The RPC is idempotent. A returned create_time at or after our
    // pre-call timestamp means the row was inserted by *this* call —
    // i.e. a fresh first-ever workspace for this user.
    const freshlyCreated = workspace.createTime >= calledAt
    await primeLocalWorkspace(repo, workspace)
    await primeLocalMembership(repo, {
      id: `bootstrap-${workspace.id}`,
      workspaceId: workspace.id,
      userId: repo.currentUser.id,
      role: 'owner',
      createTime: workspace.createTime,
    })
    return {id: workspace.id, freshlyCreated}
  }

  const locals = await listLocalWorkspaces(repo)
  if (locals.length > 0) return {id: locals[0].id, freshlyCreated: false}

  throw new Error('No workspace available and remote sync is disabled')
}

const getInitialBlock = memoize(
  async (
    repo: Repo,
    requestedWorkspaceId: string | undefined,
    requestedBlockId: string | undefined,
    useRemoteSync: boolean,
  ): Promise<{workspaceId: string, block: Block}> => {
    const {id: workspaceId, freshlyCreated} = await resolveWorkspaceId(
      repo,
      requestedWorkspaceId,
      useRemoteSync,
    )
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

    if (!rootId && useRemoteSync && !freshlyCreated) {
      // Existing workspace, blocks not yet local — they're coming via sync.
      // Poll until the first root block appears or we give up. We do NOT
      // fall back to a local seed for non-fresh workspaces: generating local
      // blocks for a workspace whose roots are still in transit creates
      // duplicate roots that fight on the server.
      rootId = await pollForLocalRootBlock(repo, workspaceId, 12000)
    }

    if (rootId) {
      writeAppHash(workspaceId, rootId)
      return {workspaceId, block: repo.find(rootId)}
    }

    if (!freshlyCreated) {
      // Existing workspace, but no root block has reached us. Don't seed —
      // surface the situation so the user can reload (sync may simply be
      // slow) instead of silently creating a duplicate root that will
      // collide with the real one once it arrives.
      throw new Error(
        `Workspace ${workspaceId} has no blocks yet. If you just joined, give sync a moment and reload.`,
      )
    }

    // Freshly created workspace with no remote blocks: seed the starter tree.
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

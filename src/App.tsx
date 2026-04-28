import { BlockComponent } from './components/BlockComponent'
import { BlockContextProvider } from '@/context/block.tsx'
import { use, useEffect } from 'react'
import { getRootBlock, Block } from '@/data/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { useHash, useSearchParam } from 'react-use'
import { Repo } from '@/data/repo'
import { memoize } from 'lodash'
import { hasRemoteSyncConfig } from '@/services/powersync.ts'
import { AppRuntimeProvider } from '@/extensions/AppRuntimeProvider.tsx'
import {
  canAccessRemoteWorkspace,
  ensurePersonalWorkspace,
  getLocalMemberRole,
  getLocalWorkspace,
  listLocalWorkspaces,
  primeLocalWorkspaceAndMember,
} from '@/data/workspaces.ts'
import { parseAppHash, writeAppHash } from '@/utils/routing.ts'
import { recallRememberedWorkspace, rememberWorkspace } from '@/utils/lastWorkspace.ts'
import { seedDailyPage, seedTutorial } from '@/initData.ts'
import { useMyWorkspaceRoles } from '@/hooks/useWorkspaces.ts'
import { getOrCreateDailyNote, todayIso } from '@/data/dailyNotes.ts'

// Resolved-workspace bundle. `seedRootBlockId` is non-null only when this
// run inserted a brand-new workspace via ensure_personal_workspace; the
// caller uses it to install the starter tutorial into the empty seed root
// the RPC created server-side. Any path that returned an existing
// workspace (URL nav, remembered, RPC returned an already-existing row)
// leaves it null — those workspaces' blocks are arriving via PowerSync
// and we must not pre-empt them with a local seed.
interface ResolvedWorkspace {
  id: string
  seedRootBlockId: string | null
}

const resolveWorkspace = async (
  repo: Repo,
  requestedWorkspaceId: string | undefined,
  useRemoteSync: boolean,
): Promise<ResolvedWorkspace> => {
  if (requestedWorkspaceId) {
    // Fast path: if PowerSync has already replicated this workspace into
    // our local DB, RLS allowed it — we have access, trust the URL.
    const localWs = await getLocalWorkspace(repo, requestedWorkspaceId)
    if (localWs) return {id: localWs.id, seedRootBlockId: null}

    // Slow path: not local. This could be either "we don't have access"
    // or "we have access but sync hasn't replicated yet". Ask the server
    // (RLS-gated) to disambiguate. We can't poll local sqlite for this:
    // `db.waitForFirstSync` resolves instantly on subsequent sessions
    // (persistent IndexedDB), and a missing row could legitimately mean
    // either case.
    if (useRemoteSync) {
      const access = await canAccessRemoteWorkspace(requestedWorkspaceId)
      if (access.kind === 'allowed') {
        // Server confirms access; getInitialBlock will poll for the blocks
        // to land via sync.
        return {id: requestedWorkspaceId, seedRootBlockId: null}
      }
      if (access.kind === 'unknown') {
        // Transport-level failure (offline, 5xx, JWT mid-refresh). We don't
        // know if the user has access. Trust the URL hash rather than
        // silently bumping them to a different workspace — the misroute is
        // worse UX than a momentary "no blocks yet" page (which the user
        // can fix with a reload once back online). If they really lack
        // access, the next online bootstrap re-runs this check and falls
        // through cleanly.
        console.warn(
          `canAccessRemoteWorkspace failed for ${requestedWorkspaceId}; trusting URL workspace and proceeding`,
          access.error,
        )
        return {id: requestedWorkspaceId, seedRootBlockId: null}
      }
      console.warn(
        `Workspace ${requestedWorkspaceId} from URL is not accessible; falling back to default workspace.`,
      )
    }
    // Confirmed-denied (or no remote sync) — fall through to default flow.
    // The eventual writeAppHash will overwrite the bad hash.
  }

  const remembered = recallRememberedWorkspace()
  if (remembered) {
    const ws = await getLocalWorkspace(repo, remembered)
    if (ws) return {id: ws.id, seedRootBlockId: null}
  }

  if (useRemoteSync) {
    const result = await ensurePersonalWorkspace()
    // Prime with the canonical member row from the RPC. Priming with a
    // synthetic id (and waiting for sync to deliver the real one) would
    // leave two membership rows in local sqlite, since the raw table has
    // no (workspace_id, user_id) UNIQUE constraint.
    await primeLocalWorkspaceAndMember(repo, result.workspace, result.member)
    return {
      id: result.workspace.id,
      seedRootBlockId: result.inserted ? result.rootBlockId : null,
    }
  }

  const locals = await listLocalWorkspaces(repo)
  if (locals.length > 0) return {id: locals[0].id, seedRootBlockId: null}

  throw new Error('No workspace available and remote sync is disabled')
}

const getInitialBlock = memoize(
  async (
    repo: Repo,
    requestedWorkspaceId: string | undefined,
    requestedBlockId: string | undefined,
    useRemoteSync: boolean,
  ): Promise<{workspaceId: string, block: Block}> => {
    const {id: workspaceId, seedRootBlockId} = await resolveWorkspace(
      repo,
      requestedWorkspaceId,
      useRemoteSync,
    )
    repo.setActiveWorkspaceId(workspaceId)

    // Derive read-only from the local membership row. workspace_members rides
    // the same sync stream as workspaces, so for any workspace we just
    // resolved as accessible, the role row is normally already local. Null
    // (membership not yet synced) defaults to read-only=false; if the role
    // is actually 'viewer', the very next sync tick flips us — and any
    // edits attempted in the meantime would be RLS-rejected server-side
    // anyway.
    const role = await getLocalMemberRole(repo, workspaceId, repo.currentUser.id)
    repo.setReadOnly(role === 'viewer')

    rememberWorkspace(workspaceId)

    if (requestedBlockId && await repo.exists(requestedBlockId)) {
      const block = repo.find(requestedBlockId)
      const data = await block.data()
      if (data && data.workspaceId === workspaceId) {
        writeAppHash(workspaceId, requestedBlockId)
        return {workspaceId, block}
      }
    }

    // Freshly inserted personal workspace: the RPC seeded an empty root
    // block at the deterministic daily-note id. Populate it as today's
    // daily note AND install the tutorial as a separate parent-less
    // page. The daily page gets a `[[Tutorial]]` bullet at the top so
    // first-run users can find it from the home view without us
    // hijacking the landing page. Returning users land on the empty
    // typing bullet below it as usual.
    if (seedRootBlockId) {
      seedTutorial(repo, workspaceId)
      seedDailyPage(repo, seedRootBlockId, workspaceId, ['[[Tutorial]]'])
      await repo.flush()
      writeAppHash(workspaceId, seedRootBlockId)
      return {workspaceId, block: repo.find(seedRootBlockId)}
    }

    // No requested block — land on today's daily note. getOrCreateDailyNote
    // is idempotent under deterministic UUIDs: two clients booting offline
    // converge on the same row on first sync. If a workspace seeder already
    // created today's page under a server-supplied id, the alias-first
    // lookup inside getOrCreateDailyNote reuses that row instead of
    // creating a duplicate.
    //
    // We don't wait for any pre-existing blocks to land via sync — today's
    // note is fine to create locally even on a fresh client; the upsert
    // resolves cleanly when sync catches up.
    const dailyNote = await getOrCreateDailyNote(repo, workspaceId, todayIso())
    await repo.flush()
    writeAppHash(workspaceId, dailyNote.id)
    return {workspaceId, block: dailyNote}
  },
  (repo, workspaceId, blockId, useRemoteSync) =>
    `${repo.instanceId}:${workspaceId ?? '__no_ws__'}:${blockId ?? '__no_block__'}:${useRemoteSync ? 'remote' : 'local'}`,
)

const App = () => {
  const repo = useRepo()
  // useHash subscribes to the browser `hashchange` event. react-use's
  // useLocation only listens for popstate/pushstate/replacestate, so a
  // plain `window.location.hash = X` would not re-render this component —
  // historically the workspace switcher worked around that by hard-reloading
  // the page on every navigation. With useHash, switching workspaces just
  // updates the hash and React re-resolves through getInitialBlock.
  const [hash] = useHash()
  const safeMode = Boolean(useSearchParam('safeMode'))

  const {workspaceId: requestedWorkspaceId, blockId: requestedBlockId} = parseAppHash(hash)
  const {workspaceId: activeWorkspaceId, block: handle} = use(
    getInitialBlock(repo, requestedWorkspaceId, requestedBlockId, hasRemoteSyncConfig),
  )
  const rootBlock = use(getRootBlock(repo.find(handle.id)))

  // Reactive role tracking. The imperative setReadOnly inside
  // resolveWorkspace handles the *initial* render (so the first paint
  // already has the right flag). This effect handles role changes pushed by
  // the server mid-session — e.g. an owner demoting an editor to viewer
  // while they're online — without requiring a reload.
  const {rolesByWorkspaceId} = useMyWorkspaceRoles()
  const activeRole = rolesByWorkspaceId.get(activeWorkspaceId)
  useEffect(() => {
    if (!activeRole) return
    repo.setReadOnly(activeRole === 'viewer')
  }, [activeRole, repo])

  return (
    <BlockContextProvider initialValue={{rootBlockId: rootBlock.id, topLevel: true, safeMode}}>
      <AppRuntimeProvider rootBlock={rootBlock} safeMode={safeMode}>
        <BlockComponent blockId={handle.id}/>
      </AppRuntimeProvider>
    </BlockContextProvider>
  )
}

export default App

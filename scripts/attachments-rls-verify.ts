/**
 * Pre-deploy verification of the `attachments` Storage RLS (design §10) against a
 * REAL Supabase stack, with REAL gotrue users per role. This is the faithful test
 * of the migration's policies — storage RLS can't be unit-tested (it needs real
 * gotrue + real Storage), and a pgTAP stub would test a fiction.
 *
 * Run BEFORE `db push`, or any time, against a stack where the bucket + policies
 * are already applied (hosted post-push; or local after applying the migration
 * once Storage is up):
 *
 *   SUPABASE_URL=... ANON_KEY=... SUPABASE_SECRET_KEY=... yarn rls:verify-attachments
 *
 * SUPABASE_SECRET_KEY is the privileged key (a modern `sb_secret_…` secret key, or
 * a legacy service_role JWT — the local stack still issues the latter); it bypasses
 * RLS to set up the test users/workspaces. Exercises the post-§10.1-reversal
 * contract: direct writer-gated INSERT (flat, non-empty path), member SELECT, NO
 * UPDATE (immutability / first-write-wins), writer DELETE. NOT part of
 * `yarn run check` — it needs a live stack.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { isAlreadyExists } from '@/attachments/blobStore'

const url = process.env.SUPABASE_URL
const anon = process.env.ANON_KEY
const secret = process.env.SUPABASE_SECRET_KEY
if (!url || !anon || !secret) {
  console.error('need SUPABASE_URL + ANON_KEY + SUPABASE_SECRET_KEY in the environment')
  process.exit(2)
}

const BUCKET = 'attachments'
const noPersist = { auth: { autoRefreshToken: false, persistSession: false } }
const admin = createClient(url, secret, noPersist) // secret key — bypasses RLS for setup
const rid = Math.random().toString(36).slice(2, 8)
const bytes = () => new Uint8Array([1, 2, 3, 4])

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}  ${detail}`)
  }
}

interface User {
  id: string
  client: SupabaseClient
}

async function makeUser(tag: string): Promise<User> {
  const email = `rlsv-${rid}-${tag}@example.com`
  const password = 'Password123!'
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`createUser ${tag}: ${error?.message}`)
  const client = createClient(url!, anon!, noPersist)
  const { error: signinErr } = await client.auth.signInWithPassword({ email, password })
  if (signinErr) throw new Error(`signin ${tag}: ${signinErr.message}`)
  return { id: data.user.id, client }
}

// Track every gotrue user + workspace we create so the run-level `finally` can
// tear them down on EVERY exit path — including a mid-setup throw. Without this a
// partial run (a failed seed/upload after some users exist) orphans real
// users/workspaces/objects in whatever stack this hit (esp. hosted).
const createdUsers: User[] = []
const createdWorkspaces: string[] = []
async function newUser(tag: string): Promise<User> {
  const u = await makeUser(tag)
  createdUsers.push(u)
  return u
}

/** Attempt an upload as `client`; report allowed (no error) vs denied + the error
 *  (so callers can classify it through blobStore's `isAlreadyExists`). */
async function tryUpload(client: SupabaseClient, path: string, upsert = false) {
  const { error } = await client.storage
    .from(BUCKET)
    .upload(path, bytes(), { upsert, contentType: 'application/octet-stream' })
  if (!error) return { allowed: true as const }
  const e = error as { statusCode?: string; status?: number }
  return { allowed: false as const, status: e.statusCode ?? (e.status != null ? String(e.status) : '?'), error: e }
}

/** Issue a RAW authenticated Storage upload, bypassing supabase-js's path
 *  normalization. storage-js's `_removeEmptyFolders` strips a trailing slash
 *  CLIENT-side, so `tryUpload('<ws>/')` never lets the server see a name ending in
 *  '/' — it ends up exercising `array_length(...) = 1` (via the stripped bare
 *  `<ws>`), NOT `right(name,1) <> '/'`. To actually exercise the empty-key guard we
 *  must hand the server the literal trailing-slash name ourselves. */
async function rawUpload(token: string, objectName: string) {
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${objectName}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      apikey: anon!,
      'content-type': 'application/octet-stream',
      'x-upsert': 'false',
    },
    body: bytes(),
  })
  return { allowed: res.ok, status: String(res.status) }
}

/** The signed-in user's access token, for `rawUpload` (the upload rides the user's
 *  own RLS identity, exactly as supabase-js would). */
async function accessToken(client: SupabaseClient): Promise<string> {
  const { data } = await client.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('no active access token for raw upload')
  return token
}

const canRead = async (client: SupabaseClient, path: string) => {
  const { data, error } = await client.storage.from(BUCKET).download(path)
  return !error && !!data
}

/** Does the object exist at all (read with the service role, bypassing RLS)? */
const objectExists = async (path: string) => {
  const { data, error } = await admin.storage.from(BUCKET).download(path)
  return !error && !!data
}

async function run() {
  console.log(`— set up real users + workspaces (run ${rid}) —`)
  const owner = await newUser('owner')
  const editor = await newUser('editor')
  const viewer = await newUser('viewer')
  const stranger = await newUser('stranger')
  const ws = `rlsws-${rid}`
  const otherWs = `rlsws-${rid}-other`
  const now = Date.now()

  const seedWorkspace = async (id: string, ownerId: string) => {
    const { error } = await admin
      .from('workspaces')
      .insert({ id, name: id, owner_user_id: ownerId, create_time: now, update_time: now, encryption_mode: 'none' })
    if (error) throw new Error(`seed workspace ${id}: ${error.message}`)
    createdWorkspaces.push(id)
  }
  const seedMember = async (wsId: string, userId: string, role: string) => {
    const { error } = await admin.from('workspace_members').insert({
      id: `m-${rid}-${wsId}-${role}`,
      workspace_id: wsId,
      user_id: userId,
      role,
      create_time: now,
    })
    if (error) throw new Error(`seed member ${role}: ${error.message}`)
  }

  await seedWorkspace(ws, owner.id)
  await seedWorkspace(otherWs, owner.id) // owner is the ONLY member of otherWs
  await seedMember(ws, owner.id, 'owner')
  await seedMember(ws, editor.id, 'editor')
  await seedMember(ws, viewer.id, 'viewer')

  const key = 'sha256deadbeef'
  const path = `${ws}/${key}`
  const ownerToken = await accessToken(owner.client) // for the raw (storage-js-bypassing) empty-key probe

  console.log('\n— INSERT: writer-gated, flat, no cross-workspace —')
  check('owner (writer) uploads a flat object', (await tryUpload(owner.client, path)).allowed)
  check('editor (writer) uploads', (await tryUpload(editor.client, `${ws}/k-editor`)).allowed)
  check('viewer (member, not writer) upload DENIED', !(await tryUpload(viewer.client, `${ws}/k-viewer`)).allowed)
  check('stranger (non-member) upload DENIED', !(await tryUpload(stranger.client, `${ws}/k-stranger`)).allowed)
  check('nested path <ws>/sub/k upload DENIED (flat layout)', !(await tryUpload(owner.client, `${ws}/sub/k`)).allowed)
  // The migration rejects an empty content-key (`<ws>/`) — a key-less object that
  // passes the 1-segment check but evades the resolver — with TWO guards, and they
  // must be exercised separately:
  //  * storage-js strips the trailing slash CLIENT-side (`_removeEmptyFolders`), so
  //    this `<ws>/` upload reaches the server as bare `<ws>`, exercising
  //    `array_length(storage.foldername(name),1) = 1` (empty array → NULL ≠ 1).
  check('client-normalized <ws>/ → bare <ws> upload DENIED (array_length=1)', !(await tryUpload(owner.client, `${ws}/`)).allowed)
  //  * to exercise `right(name,1) <> '/'` the server must actually SEE a name ending
  //    in '/', which only a raw request (bypassing storage-js) can deliver. Without
  //    this, that guard could be dropped from the migration and the test stay green.
  check('empty content-key <ws>/ (raw, server-side) upload DENIED (right(name,1))', !(await rawUpload(ownerToken, `${ws}/`)).allowed)
  check(
    'cross-workspace upload to otherWs DENIED (editor is not a writer there)',
    !(await tryUpload(editor.client, `${otherWs}/k-cross`)).allowed,
  )

  console.log('\n— SELECT: member-gated —')
  check('owner (member) reads', await canRead(owner.client, path))
  check('viewer (member) reads', await canRead(viewer.client, path))
  check('stranger (non-member) read DENIED', !(await canRead(stranger.client, path)))

  console.log('\n— UPDATE: none → immutability / first-write-wins —')
  const dup = await tryUpload(owner.client, path, false)
  check(
    're-upload to an existing path → already-exists (first-write-wins, not overwrite)',
    !dup.allowed && isAlreadyExists(dup.error),
    `status ${dup.allowed ? 'allowed' : dup.status}`,
  )
  check('overwrite via upsert:true DENIED (no UPDATE policy)', !(await tryUpload(owner.client, path, true)).allowed)

  console.log('\n— DELETE: writer-gated —')
  // supabase-js `remove` silently no-ops on an RLS-denied delete, so assert via
  // the EFFECT (the object survives a viewer delete, and is gone after a writer's).
  await viewer.client.storage.from(BUCKET).remove([path])
  check('viewer (non-writer) delete had NO effect (object survives)', await objectExists(path))
  await owner.client.storage.from(BUCKET).remove([path])
  check('writer delete removed the object', !(await objectExists(path)))

}

async function cleanup(workspaceIds: string[], users: User[]) {
  for (const wsId of workspaceIds) {
    const { data } = await admin.storage.from(BUCKET).list(wsId)
    if (data?.length) await admin.storage.from(BUCKET).remove(data.map((o) => `${wsId}/${o.name}`))
  }
  await admin.from('workspace_members').delete().in('workspace_id', workspaceIds)
  await admin.from('workspaces').delete().in('id', workspaceIds)
  for (const u of users) await admin.auth.admin.deleteUser(u.id)
}

run()
  .then(() => {
    console.log(`\n=== ${pass} passed, ${fail} failed ===`)
    process.exitCode = fail ? 1 : 0
  })
  .catch((e) => {
    console.error('FATAL', e)
    process.exitCode = 3
  })
  .finally(async () => {
    // Always tear down what we created, on every exit path (pass, check-fail, or a
    // mid-run throw) — orphaned users/workspaces/objects must never linger in the
    // target stack. cleanup is itself best-effort: a teardown error is logged, not
    // allowed to mask the run's real exit code.
    try {
      await cleanup(createdWorkspaces, createdUsers)
    } catch (e) {
      console.error('cleanup failed — orphans may remain in the target stack:', e)
    }
    process.exit(process.exitCode ?? 0)
  })

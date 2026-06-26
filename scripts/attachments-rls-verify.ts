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
 *   SUPABASE_URL=... ANON_KEY=... SERVICE_ROLE_KEY=... yarn rls:verify-attachments
 *
 * Exercises the post-§10.1-reversal contract: direct writer-gated INSERT (flat,
 * non-empty path), member SELECT, NO UPDATE (immutability / first-write-wins),
 * writer DELETE. NOT part of `yarn run check` — it needs a live stack.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const anon = process.env.ANON_KEY
const service = process.env.SERVICE_ROLE_KEY
if (!url || !anon || !service) {
  console.error('need SUPABASE_URL + ANON_KEY + SERVICE_ROLE_KEY in the environment')
  process.exit(2)
}

const BUCKET = 'attachments'
// Storage signals "object already exists" as EITHER HTTP 409 or a symbolic code,
// depending on the storage-api version (mirrors blobStore's ALREADY_EXISTS_CODES).
// Match both so this pre-deploy gate can't FALSE-FAIL on a stack that returns the
// word form while the policy is in fact behaving (first-write-wins).
const ALREADY_EXISTS = new Set(['409', 'ResourceAlreadyExists', 'KeyAlreadyExists', 'Duplicate'])
const noPersist = { auth: { autoRefreshToken: false, persistSession: false } }
const admin = createClient(url, service, noPersist) // service role — bypasses RLS for setup
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

/** Attempt an upload as `client`; report allowed (no error) vs denied + status. */
async function tryUpload(client: SupabaseClient, path: string, upsert = false) {
  const { error } = await client.storage
    .from(BUCKET)
    .upload(path, bytes(), { upsert, contentType: 'application/octet-stream' })
  if (!error) return { allowed: true as const }
  const e = error as { statusCode?: string; status?: number }
  return { allowed: false as const, status: e.statusCode ?? (e.status != null ? String(e.status) : '?') }
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
  const owner = await makeUser('owner')
  const editor = await makeUser('editor')
  const viewer = await makeUser('viewer')
  const stranger = await makeUser('stranger')
  const ws = `rlsws-${rid}`
  const otherWs = `rlsws-${rid}-other`
  const now = Date.now()

  const seedWorkspace = async (id: string, ownerId: string) => {
    const { error } = await admin
      .from('workspaces')
      .insert({ id, name: id, owner_user_id: ownerId, create_time: now, update_time: now, encryption_mode: 'none' })
    if (error) throw new Error(`seed workspace ${id}: ${error.message}`)
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

  console.log('\n— INSERT: writer-gated, flat, no cross-workspace —')
  check('owner (writer) uploads a flat object', (await tryUpload(owner.client, path)).allowed)
  check('editor (writer) uploads', (await tryUpload(editor.client, `${ws}/k-editor`)).allowed)
  check('viewer (member, not writer) upload DENIED', !(await tryUpload(viewer.client, `${ws}/k-viewer`)).allowed)
  check('stranger (non-member) upload DENIED', !(await tryUpload(stranger.client, `${ws}/k-stranger`)).allowed)
  check('nested path <ws>/sub/k upload DENIED (flat layout)', !(await tryUpload(owner.client, `${ws}/sub/k`)).allowed)
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
    !dup.allowed && ALREADY_EXISTS.has(dup.status),
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

  await cleanup([ws, otherWs], [owner, editor, viewer, stranger])
  console.log(`\n=== ${pass} passed, ${fail} failed ===`)
  process.exit(fail ? 1 : 0)
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

run().catch((e) => {
  console.error('FATAL', e)
  process.exit(3)
})

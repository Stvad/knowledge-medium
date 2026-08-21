/**
 * Contract test for the `workspaces.properties_migration` trigger, against a REAL
 * Supabase stack with REAL gotrue users — the same shape as
 * `attachments-rls-verify.ts` and for the same reason: the rule the trigger
 * encodes is about WHO is writing, so a stubbed `auth.uid()` over a fixture table
 * would be testing a fiction. Here the write goes through PostgREST as the
 * `authenticated` role carrying a real JWT, exactly as the client's
 * `flipWorkspaceToChildBackedProperties` does.
 *
 * Run BEFORE `db push`, or any time, against a stack with the migrations applied:
 *
 *   SUPABASE_URL=... ANON_KEY=... SUPABASE_SECRET_KEY=... pnpm rls:verify-properties-flip
 *
 * The contract (PR #386's migration as narrowed by the owner-flip successor):
 *   - the workspace OWNER may advance 'cell' -> 'children', and only that step,
 *     where "owner" is a claim an editor cannot manufacture — see the
 *     self-promotion case, which is the one this contract actually rests on;
 *   - every other transition is service-role, 'children' -> 'cell-off' included —
 *     it retires the cell as a synced fallback, safe only once every device has
 *     migrated, which no single client can attest to;
 *   - forward-only for everyone, service role included;
 *   - e2ee workspaces are refused outright, service role included.
 *
 * TWO THINGS HERE ARE EASY TO GET WRONG AND ARE ASSERTED EXPLICITLY.
 *
 * An UPDATE that RLS filters to zero rows SUCCEEDS. So "no error" is not evidence
 * the write landed, and a deny assertion that only checks for an error would pass
 * against a trigger that had been deleted. Every case below reads the row back
 * with the service role and asserts the VALUE, which is the only thing that
 * distinguishes allowed from refused-or-silently-dropped.
 *
 * And a refusal must carry SQLSTATE 23514 (check_violation), not the default
 * P0001. 23514 is PERMANENT, so a stale or buggy client PATCH lands in the
 * upload-rejection quarantine; under P0001 the same PATCH retries forever. That is
 * a property of the migration nothing else would catch, so it is asserted per
 * refusal rather than assumed.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const anon = process.env.ANON_KEY
const secret = process.env.SUPABASE_SECRET_KEY
if (!url || !anon || !secret) {
  console.error('need SUPABASE_URL + ANON_KEY + SUPABASE_SECRET_KEY in the environment')
  process.exit(2)
}

const noPersist = {auth: {autoRefreshToken: false, persistSession: false}}
const admin = createClient(url, secret, noPersist) // secret key — bypasses RLS for setup
const rid = Math.random().toString(36).slice(2, 8)

/** 40 base64url chars = 10 full groups = 30 bytes, clearing the 28-byte floor
 *  `is_enc_v1_envelope` enforces. Fixed rather than derived: this is a shape the
 *  server checks, and a generated value that drifted out of shape would fail the
 *  INSERT with an error about the canary, nowhere near what is under test. */
const E2EE_CANARY = `enc:v1:${'AbCd'.repeat(10)}`

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`) }
  else { fail += 1; console.log(`  ❌ ${name}  ${detail}`) }
}

interface User { id: string; client: SupabaseClient }

const createdUsers: User[] = []
const createdWorkspaces: string[] = []

async function newUser(tag: string): Promise<User> {
  const email = `pmv-${rid}-${tag}@example.com`
  const password = 'Password123!'
  const {data, error} = await admin.auth.admin.createUser({email, password, email_confirm: true})
  if (error || !data.user) throw new Error(`createUser ${tag}: ${error?.message}`)
  const client = createClient(url!, anon!, noPersist)
  const {error: signinErr} = await client.auth.signInWithPassword({email, password})
  if (signinErr) throw new Error(`signin ${tag}: ${signinErr.message}`)
  const user = {id: data.user.id, client}
  createdUsers.push(user)
  return user
}

/** The stored state, read past RLS. The only trustworthy witness of what landed. */
const stateOf = async (id: string): Promise<string | null> => {
  const {data} = await admin
    .from('workspaces').select('properties_migration').eq('id', id).maybeSingle()
  return (data as {properties_migration: string} | null)?.properties_migration ?? null
}

/** Attempt the transition and report BOTH what the API said and what actually
 *  landed, so a caller can tell a refusal from a silently-dropped write. */
const advance = async (client: SupabaseClient, id: string, to: string) => {
  const {error} = await client.from('workspaces')
    .update({properties_migration: to}).eq('id', id)
  return {code: error?.code ?? null, message: error?.message ?? '', stored: await stateOf(id)}
}

/** The same, as the SERVICE ROLE. Separate because the two rules the operator
 *  path must still obey — forward-only and the e2ee refusal — are the ones a
 *  careless narrowing would move inside the client branch, and every assertion
 *  below driven through `owner.client` would stay green if it did. */
const advanceAsAdmin = async (id: string, to: string) => {
  const {error} = await admin.from('workspaces')
    .update({properties_migration: to}).eq('id', id)
  return {code: error?.code ?? null, stored: await stateOf(id)}
}

/** A refusal is: an error, carrying 23514, with the stored value unmoved. */
const denied = (r: {code: string | null; stored: string | null}, from: string) =>
  r.code === '23514' && r.stored === from

async function run() {
  console.log(`— set up real users + workspaces (run ${rid}) —`)
  const owner = await newUser('owner')
  const editor = await newUser('editor')
  const stranger = await newUser('stranger')
  const now = Date.now()

  const seedWorkspace = async (
    id: string, ownerId: string, state: string, encryption = 'none',
  ) => {
    const {error} = await admin.from('workspaces').insert({
      id, name: id, owner_user_id: ownerId, create_time: now, update_time: now,
      encryption_mode: encryption, properties_migration: state,
      // `workspaces_wk_canary_matches_mode` requires an enc:v1 envelope whose
      // base64url payload decodes to at least nonce+tag (28B) — a readable
      // stand-in is rejected by design, so the canary has to be shaped like one.
      ...(encryption === 'e2ee' ? {wk_canary: E2EE_CANARY} : {}),
    })
    if (error) throw new Error(`seed workspace ${id}: ${error.message}`)
    createdWorkspaces.push(id)
  }
  const seedMember = async (wsId: string, userId: string, role: string) => {
    const {error} = await admin.from('workspace_members').insert({
      id: `m-${rid}-${wsId}-${role}`, workspace_id: wsId, user_id: userId, role,
      create_time: now,
    })
    if (error) throw new Error(`seed member ${role}: ${error.message}`)
  }

  const cell = `pmvws-${rid}-cell`
  const children = `pmvws-${rid}-children`
  const off = `pmvws-${rid}-off`
  const e2ee = `pmvws-${rid}-e2ee`
  const cellB = `pmvws-${rid}-cellb`
  await seedWorkspace(cell, owner.id, 'cell')
  await seedWorkspace(cellB, owner.id, 'cell')
  await seedWorkspace(children, owner.id, 'children')
  await seedWorkspace(off, owner.id, 'cell-off')
  await seedWorkspace(e2ee, owner.id, 'cell', 'e2ee')
  // The EDITOR is what separates "owner" from "may update the row at all": RLS
  // admits any workspace writer, so without an editor on these workspaces the
  // owner-only rule would be indistinguishable from RLS doing the work.
  for (const ws of [cell, cellB, children, off, e2ee]) {
    await seedMember(ws, owner.id, 'owner')
    await seedMember(ws, editor.id, 'editor')
  }

  console.log('\n— the one step a client may take —')
  const flip = await advance(owner.client, cell, 'children')
  check('owner advances cell -> children', flip.code === null && flip.stored === 'children',
    `code ${flip.code ?? 'none'}, stored ${flip.stored}`)

  console.log('\n— who may take it —')
  const byEditor = await advance(editor.client, cellB, 'children')
  check('editor (a workspace WRITER, not the owner) DENIED', denied(byEditor, 'cell'),
    `code ${byEditor.code ?? 'none'}, stored ${byEditor.stored}`)
  // A non-member is filtered by RLS before the trigger, so the write is dropped
  // rather than refused — assert the EFFECT, since there is no error to inspect.
  const byStranger = await advance(stranger.client, cellB, 'children')
  check('stranger (non-member) leaves it at cell', byStranger.stored === 'cell',
    `stored ${byStranger.stored}`)
  const anonClient = createClient(url!, anon!, noPersist)
  const byAnon = await advance(anonClient, cellB, 'children')
  check('anonymous (no JWT) leaves it at cell', byAnon.stored === 'cell', `stored ${byAnon.stored}`)

  console.log('\n— "owner" is not a claim a writer can manufacture —')
  // The check the flip trigger performs reads `workspaces.owner_user_id`, and RLS
  // admits any workspace WRITER to update that table — so without
  // `workspaces_prevent_owner_change` an editor promotes itself in one ordinary
  // request and the owner gate is decorative. Asserting only the direct flip
  // denial above would stay green against exactly that hole.
  const promote = await editor.client.from('workspaces')
    .update({owner_user_id: editor.id}).eq('id', cellB)
  const ownerNow = await admin
    .from('workspaces').select('owner_user_id').eq('id', cellB).maybeSingle()
  check('editor cannot PATCH itself into owner_user_id',
    promote.error?.code === '23514'
      && (ownerNow.data as {owner_user_id: string} | null)?.owner_user_id === owner.id,
    `code ${promote.error?.code ?? 'none'}`)
  const afterPromote = await advance(editor.client, cellB, 'children')
  check('...so the two-step self-promote-then-flip still leaves it at cell',
    afterPromote.stored === 'cell', `stored ${afterPromote.stored}`)

  console.log('\n— which steps, for a client —')
  const toOff = await advance(owner.client, children, 'cell-off')
  check('owner children -> cell-off DENIED (retiring the synced fallback is operator-only)',
    denied(toOff, 'children'), `code ${toOff.code ?? 'none'}, stored ${toOff.stored}`)
  const skip = await advance(owner.client, cellB, 'cell-off')
  check('owner cell -> cell-off DENIED (skips a state)', denied(skip, 'cell'),
    `code ${skip.code ?? 'none'}, stored ${skip.stored}`)
  const back = await advance(owner.client, children, 'cell')
  check('owner children -> cell DENIED (backwards)', denied(back, 'children'),
    `code ${back.code ?? 'none'}, stored ${back.stored}`)
  const backOff = await advance(owner.client, off, 'children')
  check('owner cell-off -> children DENIED (backwards)', denied(backOff, 'cell-off'),
    `code ${backOff.code ?? 'none'}, stored ${backOff.stored}`)

  console.log('\n— e2ee is refused outright —')
  const e2eeFlip = await advance(owner.client, e2ee, 'children')
  check('owner cannot flip an e2ee workspace', denied(e2eeFlip, 'cell'),
    `code ${e2eeFlip.code ?? 'none'}, stored ${e2eeFlip.stored}`)

  console.log('\n— the operator path obeys the rules that are not client-only —')
  // The service role is what the runbook uses, so these two are the invariants
  // that outlive any client gate. Driven through `admin`, not `owner.client`.
  const adminBack = await advanceAsAdmin(children, 'cell')
  check('service role cannot go backwards', denied(adminBack, 'children'),
    `code ${adminBack.code ?? 'none'}, stored ${adminBack.stored}`)
  const adminE2ee = await advanceAsAdmin(e2ee, 'children')
  check('service role cannot flip an e2ee workspace', denied(adminE2ee, 'cell'),
    `code ${adminE2ee.code ?? 'none'}, stored ${adminE2ee.stored}`)
  // And the step a client may NOT take, the operator may — otherwise the two
  // assertions above would pass against a trigger that refused the service role
  // outright, which would break the runbook rather than protect it.
  const adminOff = await advanceAsAdmin(children, 'cell-off')
  check('service role advances children -> cell-off',
    adminOff.code === null && adminOff.stored === 'cell-off',
    `code ${adminOff.code ?? 'none'}, stored ${adminOff.stored}`)

  console.log('\n— the trigger does not fire on an unrelated write —')
  // The early return. Without it a rename would carry the whole rule, and an e2ee
  // workspace could not be renamed at all.
  for (const [label, ws] of [['plain', cellB], ['e2ee', e2ee]] as const) {
    const {error} = await owner.client.from('workspaces')
      .update({name: `renamed-${rid}`}).eq('id', ws)
    check(`owner renames a ${label} workspace`, error === null, error?.message ?? '')
  }
}

async function cleanup(workspaceIds: string[], users: User[]) {
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
    try {
      await cleanup(createdWorkspaces, createdUsers)
    } catch (e) {
      console.error('cleanup failed — orphans may remain in the target stack:', e)
    }
    process.exit(process.exitCode ?? 0)
  })

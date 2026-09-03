/**
 * The one way a metrics record reaches the graph.
 *
 * Both recorders keep the same shape — a per-client group under a hidden
 * ui-state subtree, one prepended block per session, typed, carrying a single
 * identity-codec property — so the guards belonging to that shape live here
 * once: eligibility re-taken inside the transaction, `skipMetadata` so
 * bookkeeping does not float the row into Recents, the type tag landing in the
 * same transaction as the create.
 *
 * Only what the SHAPE guarantees belongs here. A recorder with a stronger rule
 * passes it (`assertEligible`), and retention remains the interaction
 * recorder's own — sharing a write path does not make two recorders identical.
 *
 * THE ORDERING RULE, stated once for every write below: the eligibility check
 * is the last statement before the write it authorises, with no `await`
 * between. Everything earlier in a transaction is provisional — a throw
 * anywhere rolls it back — so an earlier check is not a second line of defence,
 * it is a check on a state the intervening reads can have outlived. Both write
 * paths live here so neither can get that order wrong by hand; a caller
 * supplies WHAT to check, never WHEN.
 *
 * What that promises, exactly: the write was authorised when it was ISSUED.
 * Not at commit — `tx.setProperty` awaits its own reads and SQL, and the commit
 * follows, so ambient state can still move underneath. No placement fixes that,
 * because every check has more asynchronous work after it; a check after the
 * write would narrow the window by one SQL round trip and leave the commit.
 * ACCEPTED: the payload then describes a span one transaction stale, and the
 * next sample's own epoch check opens a replacement rather than compounding it.
 */
import { ChangeScope, type BlockData, type PropertySchema, type TypeContribution } from '@/data/api'
import { typesProp } from '@/data/properties.js'
import type { Repo } from '@/data/repo'
import {
  getPluginUIStateBlock,
  getPluginUIStateChild,
  pluginUIStateBlockId,
  stateChildBlockId,
} from '@/data/stateBlocks.js'
import { jsonPathForProperty, type PropertyName } from '@/data/internals/typedBlockQuery.js'
import { keyAtStart } from '@/data/orderKey.js'
import { deviceSurface, getClientId } from '@/utils/clientId.js'
import { v4 as uuidv4 } from 'uuid'
import { deleteSubtreeInTx } from '@/data/subtreeDelete.js'
import { assertStillWritable, NoLongerEligible } from './sessionContext.js'

/** The property write that IS the record, stated rather than supplied as a
 *  callback. Both recorders wrote the identical one-liner, which made
 *  `skipMetadata` a flag three call sites had to remember; here the shared
 *  path applies it, so a recorder cannot write a record without it.
 *
 *  `skipMetadata` keeps `user_updated_at` — the "a person edited this" signal —
 *  unstamped for a machine write. DEFENCE IN DEPTH as of this writing, and
 *  unpinned by any test: `content: ''` plus the ui-state location already keep
 *  these rows out of every surface that orders by it. Kept because the field's
 *  meaning is what makes those surfaces correct, and new ones that order by it
 *  are added freely. */
export interface RecordWrite {
  property: PropertySchema<unknown>
  data: unknown
}

/** Apply a record write. The ONE place `skipMetadata` is decided. */
const writeRecord = async (
  tx: Parameters<Parameters<Repo['tx']>[0]>[0],
  blockId: string,
  record: RecordWrite,
): Promise<void> => {
  await tx.setProperty(blockId, record.property, record.data, { skipMetadata: true })
}

export interface ClientRecordSpec {
  workspaceId: string
  /** Type of the hidden container this recorder's groups live under. */
  containerType: TypeContribution
  /** Type applied to the record row itself, so the rows are queryable and
   *  auditable rather than inferred from tree position. */
  recordType: TypeContribution
  /** `repo.tx` description — for the tx log and for reading the diff later. */
  description: string
  /** Called TWICE, and must stay cheap and side-effect-free: once before the
   *  group ensure and the id mint, so an ineligible append refuses before the
   *  expensive step, and again under THE ORDERING RULE above as the last
   *  statement before the write. Neither is redundant — the early one is not
   *  authorisation (everything before the write is provisional), and the late
   *  one is not a refusal the caller can act on cheaply.
   *
   *  Defaults to `assertStillWritable`, which is all the shared shape can know;
   *  a recorder with a STRONGER rule must pass it, because the shared default
   *  cannot see it. The interaction recorder's attributability rule is exactly
   *  that case. */
  assertEligible?: (repo: Repo, workspaceId: string) => void
  /** Records to keep in this client's group. Required, so a recorder cannot
   *  reach the graph without stating a bound. */
  retain: number
  /** Name of the record property — retention only ever considers rows CARRYING
   *  one, since these groups are inspectable and can hold a hand-created child
   *  that must never be reachable by a cleanup pass. The NAME rather than the
   *  JSON path because retention needs both forms (SQL and in-transaction), and
   *  deriving the path from the name here is what keeps them the same rule. */
  recordName: PropertyName
  /** Writes the record property. Runs inside the create transaction. */
  record: RecordWrite
  /** Called as soon as the record is DURABLE, before the retention pass this
   *  call also runs. A caller that publishes ownership from the return value
   *  instead leaves a window in which the row is committed and readable but
   *  unclaimed — and the reader excludes this session's record by id, so it
   *  would count the live session twice. */
  onCommitted?: (blockId: string) => void
}

/** This client's group id, DERIVED — no read, no create. The reader matches on
 *  exactly this parent, so anything that has to agree with the reader about
 *  where records live must use this rather than a remembered id. */
export const clientGroupId = (
  repo: Repo,
  workspaceId: string,
  containerType: TypeContribution,
): string =>
  stateChildBlockId(
    pluginUIStateBlockId(workspaceId, repo.user.id, containerType.id),
    getClientId(),
  )

/** This client's group under `containerType`, creating it if absent.
 *
 *  These creates are NOT flagged `telemetry`: they go through the shared
 *  ui-state helpers, so they count as the user's work in `excludingTelemetry`,
 *  on both sides of the ratio a reader builds from it. ACCEPTED for its size —
 *  two transactions, on the first append for a client group and never again,
 *  against counters that accumulate for the whole page session. Threading a
 *  flag through the helpers is the worse trade: both entry points are MEMOIZED
 *  on a key that would not include it, so the argument would bind to whichever
 *  caller arrived first. */
const ensureClientGroup = async (
  repo: Repo,
  workspaceId: string,
  containerType: TypeContribution,
): Promise<string> => {
  const root = await getPluginUIStateBlock(repo, workspaceId, repo.user, containerType)
  const clientId = getClientId()
  // EXPLICITLY empty, not omitted: `ensureStateChild` defaults a missing title
  // to the namespace, which here is the client UUID — non-empty, and indexed
  // exactly like the device label it replaced.
  //
  // A block's content is FTS-indexed and listed by every block-discovery
  // surface, so a titled container is another leak into the picker beside the
  // record rows. The device label is on every record inside the group, where
  // anyone reading the series gets it anyway.
  //
  // Groups that ALREADY exist keep their old title — the ensure returns a live
  // row without rewriting it — and are deliberately left alone rather than
  // migrated: every plugin's ui-state root is titled the same way, so the
  // remaining exposure is the whole state subtree in content search, which is
  // one exclusion rather than a write per plugin per device.
  const group = await getPluginUIStateChild(root, clientId, '')
  return group.id
}

/**
 * Append one record to this client's group and return its block id.
 *
 * Create, type tag and property land in ONE transaction: split across two, a
 * failure or a closed page between them leaves a durable typed child with no
 * record on it, and the reader's window is consumed by rows carrying nothing.
 */
export const appendClientRecord = async (
  repo: Repo,
  spec: ClientRecordSpec,
): Promise<{ blockId: string; groupId: string }> => {
  const assertEligible = spec.assertEligible ?? assertStillWritable
  // BEFORE the ensure, which MINTS blocks. The callers check eligibility too,
  // but several awaits back; with the first re-take inside the transaction
  // below, a workspace that went read-only in between still got Automation
  // writes that RLS refuses and parks in the quarantine — the outcome the rule
  // exists to prevent — while the record they were minted for was refused.
  //
  // This does NOT close the window, and cannot from here: the ensure runs the
  // shared ui-state chain, which awaits a load and then opens its OWN
  // transactions, so eligibility can still lapse inside it. ACCEPTED. The
  // containers are the ones any ui-state consumer creates, they are created
  // once per client group rather than per sample, and the two alternatives are
  // both worse — reimplementing the user-page/ui-state chain inside this
  // transaction duplicates core, and making the shared helpers eligibility-aware
  // pushes one plugin's rule into machinery every plugin uses (and they are
  // memoized on a key that would not include it, so the argument would bind to
  // whichever caller arrived first).
  assertEligible(repo, spec.workspaceId)
  const groupId = await ensureClientGroup(repo, spec.workspaceId, spec.containerType)
  const blockId = uuidv4()
  // Newest-first within the group: prepend before the current first sibling.
  const first = await repo.db.getOptional<{ order_key: string }>(
    'SELECT order_key FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id LIMIT 1',
    [groupId],
  )
  await repo.tx(async (tx) => {
    // The group id comes from a MEMOIZED ensure, so a delete landing during
    // this page session is invisible to it — and `tx.create` preflights only
    // that the parent ROW exists, which a tombstone satisfies. The reader
    // matches on the derived group id, so a record written under one is
    // unreachable for good. Refusing costs this session's samples; the next
    // page load re-runs the ensure, which restores the container.
    // Both derived levels this module owns, not just the group: deleting the
    // plugin root leaves the memoized group live, and a record under a live
    // group whose own parent is a tombstone is just as unreachable.
    await assertContainersLive(tx, repo, spec.workspaceId, spec.containerType)
    await tx.create(
      {
        id: blockId,
        workspaceId: spec.workspaceId,
        parentId: groupId,
        orderKey: keyAtStart(first?.order_key ?? null),
        // EMPTY, and not a recorder's choice to make. These rows sit in the
        // user's own tree, and "live, non-empty content" is how surfaces
        // decide what a person might have written — find-replace's search
        // selects on exactly that, `core.recentBlocks` likewise. Empty content
        // is what keeps every session's telemetry row out of all of them at
        // once. Whatever a legible row would have shown is in the record
        // property already.
        content: '',
        properties: {},
      },
      { systemMint: true },
    )
    await repo.addTypeInTx(tx, blockId, spec.recordType.id, {})
    // LAST, per the ordering rule at the top of this module.
    assertEligible(repo, spec.workspaceId)
    await writeRecord(tx, blockId, spec.record)
  }, { scope: ChangeScope.Automation, telemetry: true, description: spec.description })
  spec.onCommitted?.(blockId)
  // Best-effort, and deliberately AFTER the record is committed and reported.
  // Routing a retention failure through the caller's failure path retries a
  // write that already landed: the startup recorder appends up to three records
  // for one boot, and the interaction recorder forgets the row it owns and
  // opens a second. The next append re-attempts the prune.
  try {
    await pruneGroup(repo, spec, groupId, blockId)
  } catch (err) {
    // Losing eligibility mid-pass is the expected refusal, not a fault; the next
    // append re-attempts. Anything else means the bound is not being enforced,
    // which is how a series goes unbounded, so it stays loud.
    if (!(err instanceof NoLongerEligible)) {
      console.error(`[${retentionDescription(spec)}] failed`, err)
    }
  }
  return { blockId, groupId }
}

/** Are this client's containers still live?
 *
 *  Both write paths ask, because a record under a tombstoned group or root is
 *  unreachable for good: the reader matches on the DERIVED group id, so nothing
 *  will ever look under a replacement. Sync can tombstone a container without
 *  touching the record below it, which is why the record's own liveness does
 *  not answer this. */
const assertContainersLive = async (
  tx: Parameters<Parameters<Repo['tx']>[0]>[0],
  repo: Repo,
  workspaceId: string,
  containerType: TypeContribution,
): Promise<void> => {
  const rootId = pluginUIStateBlockId(workspaceId, repo.user.id, containerType.id)
  for (const id of [rootId, clientGroupId(repo, workspaceId, containerType)]) {
    const row = await tx.get(id)
    if (!row || row.deleted) throw new NoLongerEligible()
  }
}

/** Update the record this session already owns.
 *
 *  Here rather than at the call site so the ordering rule above governs both
 *  writes: the row is read first, the caller's checks run with nothing awaited
 *  after them, and the write follows. Hand-rolled at the call site, that order
 *  was one edit away from being wrong and had no owner to state it. */
export const updateClientRecord = async (
  repo: Repo,
  spec: {
    workspaceId: string
    blockId: string
    /** The container whose liveness this update depends on, same as an append. */
    containerType: TypeContribution
    description: string
    /** Re-taken immediately before the write; a recorder's own rule. */
    assertEligible: (repo: Repo, workspaceId: string) => void
    /** Is the row still one we may write to, given the in-transaction read?
     *  `tx.get` does not filter tombstones, so liveness is asked, not implied. */
    isStillOurs: (row: BlockData | null) => boolean
    record: RecordWrite
  },
): Promise<void> => {
  await repo.tx(async (tx) => {
    const row = await tx.get(spec.blockId)
    if (!spec.isStillOurs(row)) throw new NoLongerEligible()
    // The row being live says nothing about its containers: sync can tombstone
    // the group or the plugin root without touching the record under it, and an
    // update below a dead hierarchy writes where no reader will ever look.
    await assertContainersLive(tx, repo, spec.workspaceId, spec.containerType)
    spec.assertEligible(repo, spec.workspaceId)
    await writeRecord(tx, spec.blockId, spec.record)
  }, { scope: ChangeScope.Automation, telemetry: true, description: spec.description })
}

/**
 * The ONE definition of "this client's records, newest first".
 *
 * The reader and the retention pass both select from a client's group, and a
 * disagreement between them leaves retention free to evict a row the reader
 * counts as current. They build their query from here, so a change to the rule
 * reaches both or neither.
 *
 * Three clauses:
 *  - carries a record — DEFENCE IN DEPTH, and deliberately kept. These groups
 *    are inspectable and may hold a block a person created, which is user
 *    content and neither ours to read nor delete. It cannot be what SAVES such
 *    a block from retention, though: a foreign row has no `recordedAt`, and
 *    SQLite sorts NULL last under `DESC`, so it is always past the OFFSET and
 *    always caught by the per-row re-take instead. What this clause does buy is
 *    keeping junk out of the reader's page window;
 *  - written from THIS surface: one browser profile resolves the same client id
 *    as an installed PWA and as an ordinary tab, and their timings differ for
 *    reasons the code did not cause. An unlabelled record predates the field and
 *    is admitted — dropping history over a shape question is the costlier error;
 *  - ordered by the RECORD's timestamp, not tree position: a record is updated
 *    in place, so position is creation order and a long-lived tab's row is
 *    older by position while being the newest sample. `(order_key, id)` only
 *    breaks ties, in the tree's canonical order.
 */
export const clientSeriesQuery = (
  select: string,
  opts: {
    groupId: string
    recordName: PropertyName
    deviceSurface: string
    /** Whose records these are. The group id is DERIVED from it, so the two only
     *  disagree for a row moved in by hand — which is not this client's to
     *  prune, and not this client's history to show. */
    clientId: string
    /** Kept out of the candidate set BEFORE any offset — retention bounds the
     *  records that came before the one it just wrote, not including it. */
    excludeId?: string
    /** Placeholders in `select`, and in `tail`. Passed in rather than spliced
     *  around a returned middle: both callers put a `?` in their select and
     *  another in their tail, and a caller assembling the list itself has to
     *  know how many placeholders the WHERE clause contributed — which changes
     *  with `excludeId`. Getting it wrong binds silently, and the worst case is
     *  quiet: a JSON path landing where the offset belongs makes
     *  `LIMIT -1 OFFSET '$."…"'` evaluate as `OFFSET 0`, so retention deletes
     *  the entire series. */
    selectParams?: unknown[]
    tail: string
    tailParams?: unknown[]
  },
): { sql: string; params: unknown[] } => {
  const record = jsonPathForProperty(opts.recordName)
  const label = `${record}.deviceLabel`
  const owner = `${record}.clientId`
  return {
    sql: `SELECT ${select} FROM blocks
           WHERE parent_id = ? AND deleted = 0
             ${opts.excludeId === undefined ? '' : 'AND id != ?'}
             AND json_extract(properties_json, ?) IS NOT NULL
             AND (json_extract(properties_json, ?) IS NULL
                  OR json_extract(properties_json, ?) LIKE ?)
             AND (json_extract(properties_json, ?) IS NULL
                  OR json_extract(properties_json, ?) = ?)
           ORDER BY json_extract(properties_json, ?) DESC, order_key, id
           ${opts.tail}`,
    params: [
      ...(opts.selectParams ?? []),
      opts.groupId,
      ...(opts.excludeId === undefined ? [] : [opts.excludeId]),
      record, label, label, `${opts.deviceSurface}:%`,
      owner, owner, opts.clientId,
      `${record}.recordedAt`,
      ...(opts.tailParams ?? []),
    ],
  }
}

/** Content this module wrote, as opposed to content a person typed.
 *
 *  Records are contentless now, but ones written before that carried exactly
 *  their own ISO timestamp — and those must stay prunable, or an existing
 *  device's series becomes unbounded the moment this guard exists. Anything
 *  that is not a bare timestamp was typed by hand.
 *
 *  A person who types an exact ISO timestamp into a telemetry row loses it.
 *  That is the direction to fail in: the other one leaves every pre-existing
 *  record permanently unprunable. */
const isRecorderTitle = (content: string): boolean => {
  if (content === '') return true
  const parsed = Date.parse(content)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === content
}

/** Its own tx description, not the record's: these are separate transactions
 *  with separate failure modes, and a shared description makes them
 *  indistinguishable in the tx log — where attributing a write to a call site is
 *  the whole point. */
const retentionDescription = (spec: ClientRecordSpec): string => `${spec.description} retention`

/** Drop this client's own records past `retain`, from the SAME series the
 *  reader pages — see `clientSeriesQuery`. Only this client's group, so two
 *  devices can never fight over the same rows.
 *
 *  The row just written is excluded from the candidates rather than from the
 *  offset, so the bound is `retain` older records ALONGSIDE it. */
const pruneGroup = async (
  repo: Repo,
  spec: ClientRecordSpec,
  groupId: string,
  keepId: string,
): Promise<void> => {
  const q = clientSeriesQuery('id, json_extract(properties_json, ?) AS stamp', {
    groupId, recordName: spec.recordName, deviceSurface: deviceSurface(), clientId: getClientId(),
    excludeId: keepId,
    selectParams: [`${jsonPathForProperty(spec.recordName)}.recordedAt`],
    tail: 'LIMIT -1 OFFSET ?', tailParams: [spec.retain],
  })
  const stale = await repo.db.getAll<{ id: string; stamp: number | null }>(q.sql, q.params)
  if (stale.length === 0) return
  await repo.tx(async (tx) => {
    // Deletes are the one thing here that cannot be taken back — `Automation` is
    // non-undoable — and this transaction is reached several awaits after the
    // create's own gate, across a `getAll` over the whole group. Re-take it.
    assertStillWritable(repo, spec.workspaceId)
    // Retention of a recorder's own rows in a hidden ui-state subtree: no user
    // gesture and no user-visible block, so the deletion guards — which exist to
    // protect user-authored content — have nothing to say here.
    for (const row of stale) {
      // The selection above is separated from this write by an await, and these
      // rows are hand-editable: a row that stopped being one of ours in that
      // window — stripped by a person, moved out of the group, or edited on
      // another device and synced in — is user content by the time we get the
      // lock. Re-take EVERY clause the selection used, or the re-take admits
      // rows the query would have excluded.
      //
      // `== null` and not `=== undefined`: the property codec is
      // `optionalIdentity`, whose `encode(undefined)` is `null`, so clearing the
      // record leaves the key present holding JSON null — which `json_extract`
      // reports as absent and a strict check would read as still ours.
      // `!now` and `now.deleted` are defence in depth and unpinnable through
      // this path — a hard delete cannot happen here and `tx.delete` no-ops on a
      // tombstone. The parent and property clauses below are load-bearing: the
      // property one is the ONLY thing standing between a hand-created sibling
      // and a delete, since NULL-last ordering puts every such row past the
      // OFFSET rather than inside the retained prefix.
      const now = await tx.get(row.id)
      if (!now || now.deleted || now.parentId !== groupId) continue
      const record = now.properties[spec.recordName]
      if (record == null) continue
      // The device-surface clause, re-taken like the rest. The selection admits
      // this surface's label and the absent legacy one; a row relabelled in the
      // window between belongs to a different series by the same rule the query
      // used, and deleting it would evict a row this device's reader never
      // counted.
      const label = (record as { deviceLabel?: unknown }).deviceLabel
      if (label != null && !String(label).startsWith(`${deviceSurface()}:`)) continue
      // Whose record it says it is. The group id is derived from the client id,
      // so for a row this module wrote the two cannot disagree — a row that
      // does is one a person moved in from another client's group, and this
      // client has no business pruning another's history.
      const owner = (record as { clientId?: unknown }).clientId
      if (owner != null && owner !== getClientId()) continue
      // The type tag by VALUE, not just by key. A second type added by hand
      // lives inside the same `types` property, so the key-level check below
      // cannot see it. Absent is fine — records written before this type
      // existed carry none, and reading those as edits would leave every one of
      // them unprunable.
      const tags = now.properties[typesProp.name]
      if (tags != null && !(Array.isArray(tags)
        && tags.length === 1 && tags[0] === spec.recordType.id)) continue
      // Unchanged since it was selected. This does NOT re-establish RANK, which
      // is what put the row past the bound: `Tx` exposes `get`/`peek` by id and
      // no queries, so the series cannot be re-ranked from in here. ACCEPTED —
      // a concurrent deletion of NEWER rows moves this one back inside the
      // bound and we would still drop it, costing a few samples of local
      // history. The only automated writer is another tab's retention pass,
      // which deletes from the same far end and whose deletes this loop no-ops
      // on; reaching the case needs a person hand-deleting newer rows mid-append.
      if ((record as { recordedAt?: unknown }).recordedAt !== row.stamp) continue
      // Hand edits to the record itself, which is inspectable by design and so
      // can be typed into or annotated with another property. Both are things
      // an Automation-scope delete would take with no undo behind it.
      if (!isRecorderTitle(now.content)) continue
      // `types` is the type tag this module applies, not a hand edit.
      const ours = new Set([spec.recordName, typesProp.name])
      if (Object.keys(now.properties).some((key) => !ours.has(key))) continue
      // Property machinery is ours; anything else under a record was put there
      // by hand. Skipping is the right direction to fail: the bound is a bound,
      // and exceeding it by the records a person has annotated costs disk,
      // while the alternative tombstones their note under an Automation scope
      // that no undo reaches.
      //
      // ONE level, deliberately. Descending looks like the thorough choice and
      // is the opposite: a field row's values are exactly its children with the
      // form bit unset (`isFieldValueChild`), so every generated value row
      // reads as foreign one level down, no record is ever prunable in a
      // child-backed workspace, and both series grow without bound. That is a
      // worse failure than the one descending would catch — a note tucked under
      // a property's value row, which the app itself already treats as a value.
      const foreign = await tx.childrenOf(row.id, undefined, { hidePropertyChildren: true })
      if (foreign.length > 0) continue
      // The SUBTREE, not the row. Writing the record property materializes
      // field/value rows beneath it where properties are blocks, and a bare
      // delete tombstones the parent while leaving those live — invisible
      // machinery accumulating under a tombstone on every retention pass, which
      // nothing later collects.
      // eslint-disable-next-line no-restricted-syntax -- programmatic delete: telemetry retention
      await deleteSubtreeInTx(tx, row.id)
    }
  }, { scope: ChangeScope.Automation, telemetry: true, description: retentionDescription(spec) })
}

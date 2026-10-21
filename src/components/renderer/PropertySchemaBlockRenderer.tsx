/** Renderer for `'property-schema'` blocks. Wraps the default block
 *  layout (so the block keeps normal indentation, children, focus,
 *  drag, hover, etc.) and only replaces the content area with a
 *  schema editor — name input, preset picker, dispatched
 *  `preset.ConfigEditor`, and a delete button. See
 *  user-defined-properties.md §4a. */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import { useHandle } from '@/hooks/block.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import {readValuePresetRegistry, readValuePresets} from '@/data/valuePresetRegistry'
import { definitionSchema, type UnbuildableCause } from '@/data/userSchemasService'
import { openExtensionsSettings } from '@/extensions/openExtensionsSettings.js'
import { isValidSeededDefinition } from '@/data/definitionSeeds.js'
import { isGrammarShapedLabel, isRoundTrippableReferenceLabel } from '@/data/referenceBlock'
import { selectablePresets } from '@/components/propertyEditors/selectablePresets.js'
import {
  hasBlockType,
  presetConfigProp,
  presetIdProp,
  propertyNameProp,
} from '@/data/properties.js'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes.js'
import {
  ChangeScope,
  ProcessorRejection,
  propertyValue,
  type AnyJoinedValuePreset,
  type BlockData,
  type Tx,
} from '@/data/api'
import { decodeRowProperty } from '@/data/rowProperty.js'
import { parsePropertyDefinitionMetadata } from '@/data/propertyDefinitionMetadata.js'
import { jsonValuesEqual } from '@/data/internals/jsonCanonical.js'
import { Input } from '@/components/ui/input.js'
import { Button } from '@/components/ui/button.js'
import type { BlockRenderer, BlockRendererProps } from '@/types.js'
import { PropertyShapeGlyph } from '@/components/propertyPanel/shapeUi.js'
import { DefaultBlockRenderer } from './DefaultBlockRenderer.tsx'
import { deleteBlockThroughUi } from '@/utils/deleteBlockThroughUi.js'
import { trimIfEdited } from '@/utils/nameFieldCommit.js'
import { openDialog } from '@/utils/dialogs.js'
import {
  beginPropertyDefinitionFanout,
  isLargeFanout,
  markPropertyDefinitionFanoutRunning,
  queueDefinitionChange,
  type PropertyDefinitionFanoutRun,
} from '@/data/propertyDefinitionFanout.js'
import {
  ConfirmDefinitionChangeDialog,
  type ConfirmDefinitionChangeDialogProps,
  type DefinitionChangeKind,
} from './ConfirmDefinitionChangeDialog.tsx'
import { showError } from '@/utils/toast.js'

/** The three bag keys this editor writes, read the ONE way.
 *
 *  The render and the guard that re-reads the row inside the writing
 *  transaction must share it: "what the user was shown" and "what is there
 *  now" are only comparable through the same decode. `undefined` properties
 *  (no row yet) read as the defaults. */
const definitionFacts = (properties: Record<string, unknown> | undefined) => {
  const row = {properties: properties ?? {}}
  return {
    name: decodeRowProperty(row, propertyNameProp),
    presetId: decodeRowProperty(row, presetIdProp),
    config: decodeRowProperty(row, presetConfigProp),
  }
}

type DefinitionFacts = ReturnType<typeof definitionFacts>

/** What a gesture turns out to want, decided against the definition as it
 *  stands when the queue admits it. */
interface PlannedChange {
  change: Omit<ConfirmDefinitionChangeDialogProps, 'blockCount'>
  /** Everything the write REPLACES, still as the planner found it. Checked
   *  INSIDE the writing transaction, so it covers the only window left: the
   *  human pause of the confirmation, in which sync keeps running.
   *
   *  Nothing more, so a peer changing the type while this renames is not a
   *  reason to refuse the rename, and nothing less, so a re-type that also
   *  resets the config cannot drop a config edit it never looked at. */
  stillCurrent: (now: DefinitionFacts) => boolean
  write: (tx: Tx) => Promise<void>
}

/** A planner that is not making a change says why: `null` when the row
 *  already reads the way the gesture wanted, and a message when the gesture
 *  was composed against a definition that has since moved out from under it
 *  — which is not the same thing as a peer edit landing mid-confirmation, and
 *  must not be reported as one. */
type PlanResult = PlannedChange | {skip: string | null}

const OVERTAKEN = (name: string): string =>
  `“${name}” changed before this was applied, so nothing was written. `
  + 'The editor is showing where it stands now — make the change again from there.'

/** What a row is, as far as an edit from this editor goes. A change is planned
 *  against one kind and lands only on that kind: a published definition's
 *  edit fans out to its consumers, a schema block not yet published (no name
 *  yet) has none, and anything else — a tombstone, a block whose schema tag
 *  is gone — is not this editor's to write. Crossing between them meanwhile
 *  would land the edit without the fan-out the plan assumed, or write schema
 *  metadata onto an ordinary block. */
type RowKind = 'definition' | 'unpublished-schema' | 'other'

const rowKind = (row: BlockData): RowKind => {
  if (parsePropertyDefinitionMetadata(row) !== null) return 'definition'
  if (!row.deleted && hasBlockType(row, PROPERTY_SCHEMA_TYPE)) return 'unpublished-schema'
  return 'other'
}

const withoutFirst = (names: readonly string[], name: string): readonly string[] => {
  const at = names.indexOf(name)
  return at === -1 ? names : [...names.slice(0, at), ...names.slice(at + 1)]
}

const NOT_OPEN =
  'The property was not changed: its workspace is no longer the one open. '
  + 'Open it again and make the change there.'

const TX_DESCRIPTIONS: Record<DefinitionChangeKind, string> = {
  rename: 'rename property',
  type: 'change property type',
  options: 'change property options',
}

const renderConfigEditor = (
  preset: AnyJoinedValuePreset,
  value: unknown,
  onChange: (next: unknown) => void,
  /** Bumped when a config change did not land. `onChange` returns void, so
   *  remounting is the one way to make any config editor — including ones
   *  this repo did not write — drop its optimistic state. */
  generation: number,
): React.ReactNode => {
  if (!preset.ConfigEditor) return null
  const ConfigEditor = preset.ConfigEditor
  return <ConfigEditor key={generation} value={value} onChange={onChange} />
}

/** The question the definition-change processor refuses on, asked of the
 *  definition row as it stands: does its CURRENT type build a codec here, and
 *  if not, why. `null` when the controls stay: the type builds, or the row
 *  names no type yet — choosing one is how such a definition is finished. A
 *  USED one with no type is refused in the tx with its way out; only an
 *  out-of-band write reaches it, since clearing a used definition's preset is
 *  refused, so it is not worth an async consumer count here. */
const useCurrentTypeUnavailable = (
  block: BlockRendererProps['block'],
): Exclude<UnbuildableCause, 'no-preset'> | null => {
  const cores = readValuePresetRegistry(useAppRuntime()).cores
  return useHandle(block, {
    selector: row => {
      if (!row) return null
      const metadata = parsePropertyDefinitionMetadata(row)
      if (metadata === null) return null
      const built = definitionSchema(row, cores, metadata)
      return built.schema !== null || built.cause === 'no-preset' ? null : built.cause
    },
  })
}

/** Who is looking decides which ways out this editor can offer. A seed is
 *  code-owned, so its only way out is its plugin or the app. */
type NoticeAudience = 'editor' | 'viewer' | 'seed'

const NOTICE_PROBLEM: Record<
  Exclude<UnbuildableCause, 'no-preset'>,
  (type: React.ReactNode) => React.ReactNode
> = {
  'preset-not-loaded': type => <>This property uses {type}, from a plugin, or a newer
    version of the app, that isn&rsquo;t loaded on this device.</>,
  'config-unreadable': type => <>The stored settings of {type} can&rsquo;t be read on
    this device.</>,
  'build-failed': type => <>This property uses {type}, which fails to build on this
    device.</>,
}

const noticeWayOut = (
  cause: Exclude<UnbuildableCause, 'no-preset'>,
  audience: NoticeAudience,
): string => {
  // Updating first: under version skew this definition works on a newer
  // device, and deleting it here deletes it there too.
  const fix = cause === 'preset-not-loaded'
    ? 'Enable the plugin or update the app on this device'
    : 'Update the plugin or the app on this device'
  if (audience === 'seed') return `${fix}.`
  if (audience === 'viewer') {
    return `${fix}, or ask someone who can edit this workspace to delete the schema.`
  }
  return `${fix}, or delete the schema; the values blocks hold under it stay.`
}

/** Why this definition's type and config are locked, and the ways out. */
const CurrentTypeUnavailableNotice = ({presetId, cause, audience}: {
  presetId: string
  cause: Exclude<UnbuildableCause, 'no-preset'>
  audience: NoticeAudience
}) => {
  const type = presetId
    ? <>the <code className="font-mono">{presetId}</code> type</>
    : <>this property&rsquo;s type</>
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <div>
        {NOTICE_PROBLEM[cause](type)}
        {' '}Its type and settings can&rsquo;t be changed here, and while blocks use
        it, it can&rsquo;t be renamed either: only that type can read the values they
        hold under it. {noticeWayOut(cause, audience)}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        onClick={() => openExtensionsSettings('property-schema-type-unavailable')}
      >
        Manage extensions
      </Button>
    </div>
  )
}

/** Exported for the read-only regression test; production mounts it only
 *  through `PropertySchemaBlockRenderer` below. */
export const PropertySchemaContentRenderer: BlockRenderer = ({block}: BlockRendererProps) => {
  const data = useHandle(block, {
    selector: d => d ? {
      id: d.id,
      workspaceId: d.workspaceId,
      properties: d.properties,
    } : undefined,
  })
  const runtime = useAppRuntime()
  const presets = readValuePresets(runtime)
  // With no codec for what its consumers hold, every re-type and config change
  // is refused, so the controls that make one are not offered. Renames stay
  // with the transaction, which allows one that strands nothing. Not gated on
  // consumers as the transaction is: an unused definition loses nothing to
  // delete-and-recreate, and the gate would be an async count the tx re-checks.
  const typeUnavailable = useCurrentTypeUnavailable(block)

  // A materialized seed row is a kernel/plugin property *defined in code*.
  // In v1 these are code-owned and unshadowable: their name, type, config,
  // and lifecycle are fixed by the declaration. Editing the seed's own row
  // has no legitimate meaning and silently corrupts the definition — e.g.
  // switching its preset leaves a stored default the new codec can't decode,
  // which drops the whole schema to metadata-only. Render read-only so the
  // user sees what the property is without being able to mutate it. A viewer
  // (repo read-only) is the same case for a different reason.
  const isSeedBacked = data ? isValidSeededDefinition(data) : false
  const readOnly = block.repo.isReadOnly || isSeedBacked


  const facts = useMemo(() => definitionFacts(data?.properties), [data])
  const {presetId, name: propertyName, config: persistedConfig} = facts

  const preset = presets.get(presetId) ?? null

  /** Ask before a change that stops the app, hold the progress surface up for
   *  as long as the user is waiting on it, and write only what the definition
   *  in front of the planner still supports.
   *
   *  The count and the surface live here, not in the processor; see
   *  `propertyDefinitionFanout.ts` for why.
   *
   *  PLANNED AT START, NOT AT THE GESTURE. Changes are serialised, so one can
   *  wait behind another that rewrites the very row it is about; the planner
   *  therefore runs when the queue admits it, against a freshly read row, and
   *  everything derived from the row's current state — the name in the
   *  dialog, the baseline a peer edit is judged against, whether there is
   *  anything left to do at all — comes from THAT read.
   *
   *  Uniform across both sides of the threshold on purpose. Under it the
   *  window is one await and a refusal is all but unreachable — but two write
   *  paths, one guarded and one not, is how the guarded one stops being the
   *  one that runs.
   *
   *  DECLINED: re-checking the count inside the transaction — it prevents no
   *  wrong write, and a transaction holding the writer cannot raise a
   *  confirmation. Every change opens a run instead, and the surface follows
   *  the fan-out's OWN total, so one that grew past the threshold meanwhile
   *  still shows its progress. */
  const throughFanoutGate = useCallback((
    plan: (atStart: DefinitionFacts) => PlanResult,
  ): Promise<boolean> => queueDefinitionChange(async () => {
    // Every await from the read to the commit can throw, and one that escapes
    // leaves a void event handler holding the rejection and the caller's
    // cleanup unrun — so a throw anywhere is one more way of not writing.
    let workspaceId: string | null = null
    let run: PropertyDefinitionFanoutRun | null = null
    const isOpen = (id: string): boolean => block.repo.activeWorkspaceId === id
    const notOpen = (): false => {
      showError(NOT_OPEN)
      return false
    }
    try {
      // From SQL, not from the render snapshot this closure captured: the
      // point of planning at start is that the row may have moved since.
      const atStart = await block.repo.load(block.id)
      if (atStart === null) return false
      // The definition's OWN workspace — this renderer is mounted per block.
      const ws = atStart.workspaceId
      workspaceId = ws
      const kindAtStart = rowKind(atStart)
      if (kindAtStart === 'other') return false
      const planned = plan(definitionFacts(atStart.properties))
      if ('skip' in planned) {
        if (planned.skip !== null) showError(planned.skip)
        return false
      }
      const {change, stillCurrent, write} = planned
      const consumers = await block.repo.countPropertyDefinitionConsumers(block.id, ws)
      // While blocks use it, every change to a definition whose CURRENT type
      // builds nothing here is refused in its transaction, which says why —
      // so there is nothing to ask the user to approve.
      const atStartMetadata = parsePropertyDefinitionMetadata(atStart)
      const refusedInTx = atStartMetadata !== null
        && definitionSchema(atStart, block.repo.valuePresetCores, atStartMetadata).schema === null
      const large = isLargeFanout(consumers) && !refusedInTx
      // `repo.tx` admits writes to the workspace open when it STARTS and no
      // other, and the user can switch while this waits. Asked before the
      // confirmation, so nobody is asked about a workspace they left, and
      // again after it, so no run opens for a write that cannot land.
      // DECLINED: asking again inside the transaction — once `repo.tx` has
      // admitted the change it lands where the user made it, like any write
      // begun before a switch.
      if (!isOpen(ws)) return notOpen()
      if (large) {
        const confirmed = await openDialog(
          ConfirmDefinitionChangeDialog, {...change, blockCount: consumers},
        )
        if (confirmed !== true) return false
        if (!isOpen(ws)) return notOpen()
      }
      run = beginPropertyDefinitionFanout(block.id, change.propertyName, consumers)
      let applied = false
      await block.repo.tx(async tx => {
        const current = await tx.get(block.id)
        // The kind the change was planned against — see `RowKind`. `tx.get`
        // hands back a tombstone with its bag intact, so this is what keeps
        // a deleted definition out too.
        if (current === null || rowKind(current) !== kindAtStart) return
        if (!stillCurrent(definitionFacts(current.properties))) return
        // Makes this transaction's reports attributable; see
        // `PropertyDefinitionFanoutSnapshot.transactionRunning`.
        markPropertyDefinitionFanoutRunning(block.id)
        await write(tx)
        applied = true
      }, {scope: ChangeScope.BlockDefault, description: TX_DESCRIPTIONS[change.kind]})
      // Read only once `repo.tx` has RESOLVED: same-tx processors run after
      // the callback returns, so the fan-out can still refuse a change the
      // callback reached the end of.
      if (!applied) {
        showError(
          `“${change.propertyName}” changed somewhere else before this was applied, `
          + 'so nothing was written. Take another look and try again.',
        )
      }
      return applied
    } catch (error) {
      // `repo.tx` notifies the user-error channel before it rethrows, so a
      // kernel refusal has already said why in its own words and ours would
      // only contradict it. Anything else has told nobody — and a switch that
      // lands inside `repo.tx`, after the checks above, is refused there with
      // an error that says nothing a user can act on.
      if (error instanceof ProcessorRejection) return false
      if (workspaceId !== null && !isOpen(workspaceId)) return notOpen()
      console.error('[PropertySchemaContentRenderer] the change failed:', error)
      showError('The property could not be changed. See the console.')
      return false
    } finally {
      run?.end()
    }
  }), [block])

  const decodedConfig = useMemo<unknown>(() => {
    if (!preset?.configCodec) return undefined
    try {
      return preset.configCodec.decode(persistedConfig)
    } catch {
      return preset.defaultConfig
    }
  }, [persistedConfig, preset])

  // The draft is an OVERRIDE that exists only while the user is typing, not a
  // copy of the name kept in step with it. `null` means "show what the
  // definition says", so dropping it is how every path that does not write
  // gets back to the truth — including the ones that hold a name from before
  // they started, which a captured value cannot do (see `writeName`).
  //
  // Render-phase resync when the committed name changes: React supports
  // setState-during-render for this exact case. Focus is intentionally not
  // preserved — if a remote write lands mid-edit, accepting the new
  // committed name beats letting a stale draft overwrite it on the next
  // blur.
  //
  // SOMEBODY ELSE'S change, though, and `requestedNames` is what tells them
  // apart: every rename this field has asked for and not yet seen land. A
  // rename is not instant — it is planned, counted, sometimes confirmed, then
  // committed — and below the threshold the field stays live throughout, so
  // the user can blur a second name while the first is still queued and be
  // typing a third when either lands. None of those acknowledgements may read
  // as a remote edit and take the typing away. One landing settles every
  // request queued before it, since the queue runs them in order — defence in
  // depth for two landing inside one render, where the earlier name is never
  // seen and would otherwise be kept as ours for good. The enum
  // options editor works around the same seam with `pending`; #1117 is where
  // an editor gets told the outcome instead.
  const [draftName, setDraftName] = useState<string | null>(null)
  const [committedName, setCommittedName] = useState(propertyName)
  const [requestedNames, setRequestedNames] = useState<readonly string[]>([])
  if (propertyName !== committedName) {
    setCommittedName(propertyName)
    const ours = requestedNames.indexOf(propertyName)
    if (ours === -1) setDraftName(null)
    else setRequestedNames(requestedNames.slice(ours + 1))
  }
  const shownName = draftName ?? propertyName

  const writeName = useCallback(async (draft: string) => {
    const next = trimIfEdited(draft, propertyName)
    if (next === propertyName) return
    // Same invariant addSchema enforces at creation
    // (docs/properties-as-blocks-migration.html §7): the name
    // must survive a `[[name]]` round-trip — field-row retitles and every
    // re-derive-by-content path bind through that form, so a lossy label
    // (e.g. one containing `]]`) would strand the schema's field rows.
    // Reject by reverting the draft; the committed name stands.
    //
    // BOTH halves of the hygiene, matching `addSchema` — the round-trip
    // guard alone leaves the rename path open as a bypass, because
    // `((id))` and `::((id))` round-trip perfectly well (nothing about
    // them is `]]`-lossy) while reading as a reference to some other block
    // wherever the name is rendered.
    if (!isRoundTrippableReferenceLabel(next) || isGrammarShapedLabel(next)) {
      setDraftName(null)
      return
    }
    setRequestedNames(names => [...names, next])
    const wrote = await throughFanoutGate(atStart => {
      // Re-aimed at whatever the definition is called NOW: a rename carries
      // a whole replacement name and means the same thing from any starting
      // point, so a predecessor in the queue changes which name it is
      // replacing, not whether to.
      if (atStart.name === next) return {skip: null}
      return {
        change: {kind: 'rename', propertyName: atStart.name, nextName: next},
        stillCurrent: now => now.name === atStart.name,
        write: tx => tx.setProperty(block.id, propertyNameProp, next),
      }
    })
    // Anything that did not write has to put the FIELD back too: the draft is
    // what the user typed, and leaving it there shows a name the definition
    // does not have — one a later blur would then submit as a fresh rename.
    // DROPPED rather than restored to the name this closure captured, and
    // that distinction is the whole of it: when the write was refused BECAUSE
    // a peer renamed, the resync has already adopted the peer's name, so
    // writing the captured one back sticks and the next blur undoes exactly
    // the edit the refusal protected.
    //
    // Only THIS request's draft, though — the user may have typed past it
    // while it was in flight, and that newer name is not this one's to
    // discard.
    if (!wrote) {
      setRequestedNames(names => withoutFirst(names, next))
      setDraftName(current => current === next ? null : current)
    }
  }, [block, propertyName, throughFanoutGate])

  const writePresetId = useCallback(async (next: string) => {
    if (next === presetId) return
    const target = presets.get(next)
    if (!target) return
    // setProperties applies a two-key DELTA read against the fresh in-tx row —
    // NOT a whole-bag replace off the (possibly stale) `data` render snapshot,
    // which would clobber any sibling key written between render and commit.
    await throughFanoutGate(atStart => {
      if (atStart.presetId === next) return {skip: null}
      return {
        change: {kind: 'type', propertyName: atStart.name},
        // The CONFIG as well as the preset, because the write below replaces
        // both: resetting it to the new preset's default is the point, and a
        // config edit that landed since the planner looked is one this would
        // discard without ever having seen it.
        stillCurrent: now => now.presetId === atStart.presetId
          && jsonValuesEqual(now.config, atStart.config),
        write: tx => tx.setProperties(block.id, {
          set: [
            propertyValue(presetIdProp, next),
            // Reset config to the new preset's defaultConfig (re-encoded
            // through its configCodec, if any), since the previous preset's
            // config shape doesn't apply.
            propertyValue(presetConfigProp, target.configCodec
              ? target.configCodec.encode(target.defaultConfig as never) as Record<string, unknown>
              : {}),
          ],
        }),
      }
    })
  }, [block, presetId, presets, throughFanoutGate])

  // See `renderConfigEditor`: bumping this remounts the config editor, which
  // is how a change that did not land takes its optimistic state with it.
  const [configGeneration, setConfigGeneration] = useState(0)

  const writeConfig = useCallback(async (next: unknown) => {
    if (!preset?.configCodec) return
    let encoded: Record<string, unknown>
    try {
      encoded = preset.configCodec.encode(next as never) as Record<string, unknown>
    } catch (err) {
      console.warn(`[PropertySchemaContentRenderer] cannot encode config:`, err)
      return
    }
    const wrote = await throughFanoutGate(atStart => {
      // The ONE gesture that cannot be re-aimed: `encoded` is the editor's
      // view of the STORED object with one part changed, and the codec that
      // produced it is this preset's. Applied over a row that has moved it
      // would put back whatever the change before it removed — so removing
      // two choices in quick succession would silently restore the first.
      if (atStart.presetId !== presetId || !jsonValuesEqual(atStart.config, persistedConfig)) {
        return {skip: OVERTAKEN(atStart.name)}
      }
      // Nothing to write, so nothing to ask about. Reachable without any
      // editing at all: the ref picker re-emits its list when a target type
      // already on it is entered again, and counting a whole graph to
      // confirm a write of the same bytes is the confirmation at its least
      // trustworthy.
      if (jsonValuesEqual(atStart.config, encoded)) return {skip: null}
      return {
        change: {kind: 'options', propertyName: atStart.name},
        stillCurrent: now => now.presetId === presetId
          && jsonValuesEqual(now.config, persistedConfig),
        write: tx => tx.setProperty(block.id, presetConfigProp, encoded),
      }
    })
    if (!wrote) setConfigGeneration(generation => generation + 1)
  }, [block, persistedConfig, preset, presetId, throughFanoutGate])

  // Lazy delete-confirm: first click counts users; if any, ask for a
  // second click; second click (or no users) deletes. Confirm state
  // resets when name/preset/data changes so a stale count never lands.
  const [pendingDelete, setPendingDelete] = useState<{userCount: number} | null>(null)
  const [scanningUsers, setScanningUsers] = useState(false)
  const cancelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (cancelTimerRef.current !== null) clearTimeout(cancelTimerRef.current)
  }, [])

  const performDelete = useCallback(async () => {
    await deleteBlockThroughUi(block)
  }, [block])

  const handleDeleteClick = useCallback(async () => {
    if (pendingDelete) {
      setPendingDelete(null)
      await performDelete()
      return
    }
    if (!propertyName.trim()) {
      await performDelete()
      return
    }
    setScanningUsers(true)
    try {
      const userCount = await block.repo.countBlocksUsingProperty(
        propertyName,
        data?.workspaceId,
      )
      if (userCount === 0) {
        await performDelete()
        return
      }
      setPendingDelete({userCount})
      // Auto-cancel the confirm after 6s so a forgotten dialog doesn't
      // sit there waiting to fire on the next stray click.
      if (cancelTimerRef.current !== null) clearTimeout(cancelTimerRef.current)
      cancelTimerRef.current = setTimeout(() => setPendingDelete(null), 6000)
    } finally {
      setScanningUsers(false)
    }
  }, [block, data, pendingDelete, performDelete, propertyName])

  if (!data) return null

  // Hide presets that opt out of the picker (e.g. `enum`, whose options
  // can't be set here — switching a schema to it would build an empty,
  // always-failing codec), but keep the type a schema is already on.
  const presetEntries = selectablePresets(presets, presetId)

  return (
    <div className="w-full space-y-2 py-1">
      <div className="flex items-center gap-2">
        <PropertyShapeGlyph
          shape={presetId}
          Glyph={preset?.Glyph}
          className={preset ? 'text-fuchsia-500' : 'text-muted-foreground'}
        />
        <Input
          value={shownName}
          placeholder="property name"
          disabled={readOnly}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDraftName(e.target.value)}
          onBlur={() => { void writeName(shownName) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          className="h-8 max-w-md text-base font-semibold"
        />
      </div>

      <div className="grid grid-cols-[6rem,minmax(0,1fr)] items-center gap-3">
        <label className="text-xs font-semibold text-muted-foreground">Type</label>
        {typeUnavailable !== null ? (
          <code className="font-mono text-sm text-muted-foreground">{presetId || 'none'}</code>
        ) : (
          <div className="relative max-w-xs">
            <select
              className="h-9 w-full appearance-none rounded-md border border-input bg-background px-2 pr-9 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
              value={presetId}
              disabled={readOnly}
              // `void`, not a catch: the gate turns every failure into a
              // non-write, so `writePresetId` does not reject.
              onChange={(e) => { void writePresetId(e.target.value) }}
            >
              {presetEntries.map(p => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
              {!preset && presetId !== '' && (
                <option value={presetId}>{presetId} (unknown)</option>
              )}
            </select>
            <ChevronDown
              className={`pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 ${
                readOnly ? 'text-muted-foreground/45' : 'text-foreground/70'
              }`}
            />
          </div>
        )}
      </div>

      {typeUnavailable === null && preset?.ConfigEditor && (
        <div className="grid grid-cols-[6rem,minmax(0,1fr)] gap-3">
          <label className="pt-1 text-xs font-semibold text-muted-foreground">Config</label>
          {/* A real `fieldset[disabled]`, which is what makes the descendant
              form controls inert. The config editors take no readOnly prop and
              render ordinary inputs and buttons, and those stay focusable and
              operable from the KEYBOARD behind a pointer-only block — so a
              locked editor could still dispatch `writeConfig`, whose refusal
              then arrives as an unhandled rejection. `pointer-events-none`
              stays for whatever in an editor is not a form control. */}
          <fieldset
            disabled={readOnly}
            className={`m-0 min-w-0 border-0 p-0${
              readOnly ? ' pointer-events-none opacity-60' : ''}`}
          >
            {renderConfigEditor(preset, decodedConfig, writeConfig, configGeneration)}
          </fieldset>
        </div>
      )}

      {isSeedBacked && (
        <div className="text-xs text-muted-foreground">
          Built-in property defined in code — its name, type, and options are
          fixed and can&rsquo;t be edited here.
        </div>
      )}

      {typeUnavailable !== null && (
        <CurrentTypeUnavailableNotice
          presetId={presetId}
          cause={typeUnavailable}
          audience={isSeedBacked ? 'seed' : readOnly ? 'viewer' : 'editor'}
        />
      )}

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={scanningUsers}
            className="h-7 text-xs text-destructive hover:text-destructive"
            onClick={() => { void handleDeleteClick() }}
          >
            {pendingDelete
              ? `Really delete? (${pendingDelete.userCount} ${pendingDelete.userCount === 1 ? 'block uses' : 'blocks use'} this)`
              : scanningUsers
                ? 'Checking…'
                : 'Delete schema'}
          </Button>
          {pendingDelete && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setPendingDelete(null)}
              >
                Cancel
              </Button>
              <span className="text-xs text-muted-foreground">
                Their values stay; the editor falls back to an inferred type.
              </span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
PropertySchemaContentRenderer.displayName = 'PropertySchemaContentRenderer'

/** Outer wrapper: keeps the default block layout (children,
 *  indentation, drag handle, focus chrome) and swaps in the
 *  schema-editing content renderer. */
export const PropertySchemaBlockRenderer: BlockRenderer = Object.assign(
  (props: BlockRendererProps) => (
    <DefaultBlockRenderer
      {...props}
      ContentRenderer={PropertySchemaContentRenderer}
      EditContentRenderer={PropertySchemaContentRenderer}
    />
  ),
  {
    canRender: ({block}: BlockRendererProps): boolean => {
      // useRenderer's chooser also calls useData(block) before
      // running canRender, so by the time we get here block.peek()
      // is non-null on hot loads. On the very first render, peek
      // can be null — return false in that case so the chooser
      // falls back to the default renderer; once the block loads,
      // useRenderer reruns and we'll match.
      const data = block.peek()
      if (!data) return false
      const types = data.properties.types
      return Array.isArray(types) && types.includes('property-schema')
    },
    priority: () => 100,
  },
)
PropertySchemaBlockRenderer.displayName = 'PropertySchemaBlockRenderer'

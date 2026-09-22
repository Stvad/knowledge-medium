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
import {readValuePresets} from '@/data/valuePresetRegistry'
import { isValidSeededDefinition } from '@/data/definitionSeeds.js'
import { isGrammarShapedLabel, isRoundTrippableReferenceLabel } from '@/data/referenceBlock'
import { selectablePresets } from '@/components/propertyEditors/selectablePresets.js'
import {
  presetConfigProp,
  presetIdProp,
  propertyNameProp,
} from '@/data/properties.js'
import {
  ChangeScope,
  ProcessorRejection,
  propertyValue,
  type AnyJoinedValuePreset,
  type Tx,
} from '@/data/api'
import { decodeRowProperty } from '@/data/rowProperty.js'
import { parsePropertyDefinitionMetadata } from '@/data/propertyDefinitionMetadata.js'
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

/** Preset configs compared as stored text. Both sides come from the same
 *  round trip, so a re-ordering that is only cosmetically different costs a
 *  retry rather than a lost write. */
const sameConfig = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/** What a gesture turns out to want, decided against the definition as it
 *  stands when the queue admits it. */
interface PlannedChange {
  change: Omit<ConfirmDefinitionChangeDialogProps, 'blockCount'>
  /** Everything the write REPLACES, still as the planner found it. Checked
   *  inside the writing transaction, so it covers the confirmation's pause. */
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

const TX_DESCRIPTIONS: Record<DefinitionChangeKind, string> = {
  rename: 'rename property',
  type: 'change property type',
  options: 'change property options',
}

const renderConfigEditor = (
  preset: AnyJoinedValuePreset,
  value: unknown,
  onChange: (next: unknown) => void,
  /** Bumped when a config change did NOT land, which remounts the editor.
   *
   *  A config editor holds its own in-progress state and learns nothing from
   *  `onChange`, which returns void — so a change that is cancelled at the
   *  confirmation, or refused in its transaction, leaves it showing options
   *  the definition never got, and a later edit resubmits them. Nothing it
   *  can do about that by itself: the outcome is the HOST's to know. Saying
   *  "forget what you thought" is the one instruction that needs no contract
   *  and reaches every config editor, including ones this repo did not
   *  write. The cost is the caret, and only on a path where the change did
   *  not happen. */
  generation: number,
): React.ReactNode => {
  if (!preset.ConfigEditor) return null
  const ConfigEditor = preset.ConfigEditor
  return <ConfigEditor key={generation} value={value} onChange={onChange} />
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
   *  The first two live here rather than in the processor that does the work:
   *  the count is a query the gesture can afford and the transaction cannot
   *  (it already holds the writer by then), and the wait the user is owed a
   *  surface for is the whole `repo.tx`, not the consumer loop inside it — the
   *  commit and the post-commit walk over every row it touched come after.
   *  One predicate (`isLargeFanout`) decides both, so a change can never ask
   *  and then run silently, or run for a minute without having asked.
   *
   *  PLANNED AT START, NOT AT THE GESTURE. Changes are serialised, so one can
   *  wait behind another that rewrites the very row it is about; the planner
   *  therefore runs when the queue admits it, against a freshly read row, and
   *  everything derived from the row's current state — the name in the
   *  dialog, the baseline a peer edit is judged against, whether there is
   *  anything left to do at all — comes from THAT read. Snapshotting it at
   *  the gesture instead labelled dialogs with names that had moved, and made
   *  a change's own predecessor look like somebody else's edit.
   *
   *  What a planner may NOT re-aim is a payload it computed FROM the old row.
   *  A rename and a re-type carry a whole replacement value and mean the same
   *  thing whatever is there; a config edit is the editor's view of the
   *  stored object with one part changed, so applying it over a row that has
   *  moved would put back what the previous change removed. Those abandon
   *  with a message rather than rebase, and say so in their own words.
   *
   *  `stillCurrent` is then checked INSIDE the writing transaction, and
   *  covers the only window left: the human pause of the confirmation, in
   *  which sync keeps running. It names everything the write REPLACES —
   *  nothing more, so a peer changing the type while this renames is not a
   *  reason to refuse the rename, and nothing less, so a re-type that also
   *  resets the config cannot drop a config edit it never looked at.
   *
   *  Uniform across both sides of the threshold on purpose. Under it the
   *  window is one await and a refusal is all but unreachable — but two write
   *  paths, one guarded and one not, is how the guarded one stops being the
   *  one that runs.
   *
   *  The COUNT is deliberately not re-checked in the transaction, unlike the
   *  row. It would prevent no wrong write — only add a confirmation, which
   *  nothing can raise from inside a transaction that already holds the
   *  writer, so closing it means a rejection code, a retry loop and a bypass
   *  flag at every call site, permanently. DECLINED against the alternative
   *  of a fan-out that turns out large going unasked, whose outcome is the
   *  behaviour this gate replaced. */
  const throughFanoutGate = useCallback((
    plan: (atStart: DefinitionFacts) => PlanResult,
  ): Promise<boolean> => queueDefinitionChange(async () => {
    // The definition's OWN workspace, never the active one — this renderer is
    // mounted per block. With no row loaded there is nothing to scope the
    // count to, and no gesture either: every control below renders from `data`.
    const workspaceId = data?.workspaceId
    if (workspaceId === undefined) return false
    // From SQL, not from the render snapshot this closure captured: the point
    // of planning at start is that the row may have moved since.
    const atStart = await block.repo.load(block.id)
    if (atStart === null) return false
    const planned = plan(definitionFacts(atStart.properties))
    if ('skip' in planned) {
      if (planned.skip !== null) showError(planned.skip)
      return false
    }
    const {change, stillCurrent, write} = planned
    const consumers = await block.repo.countPropertyDefinitionConsumers(
      block.id, workspaceId,
    )
    const large = isLargeFanout(consumers)
    if (large) {
      const confirmed = await openDialog(
        ConfirmDefinitionChangeDialog, {...change, blockCount: consumers},
      )
      if (confirmed !== true) return false
    }
    const run = large
      ? beginPropertyDefinitionFanout(
        workspaceId, block.id, change.propertyName, consumers,
      )
      : null
    // Three outcomes, not two. A kernel REFUSAL (a re-type that would discard
    // stored values, say) comes out of `repo.tx` as a throw, and a caller
    // that let it escape leaves its cleanup unrun and a void event handler
    // holding an unhandled rejection.
    //
    // `guardPassed` is what the CALLBACK reached, `wrote` is what the
    // TRANSACTION did, and they are not the same moment: same-tx processors
    // run after the callback returns, so the fan-out this change asks for
    // can still refuse it — the commonest refusal there is. Success is
    // therefore only assignable once `repo.tx` resolves.
    let guardPassed = false
    let wrote = false
    let refused = false
    try {
      await block.repo.tx(async tx => {
        const current = await tx.get(block.id)
        // A row that is no longer a PUBLISHED definition is not one to edit,
        // and a tombstone is the reachable case: `tx.get` hands one back, its
        // bag still reads as it did, so comparing the bag alone would write
        // through to a deleted row. The fan-out then skips it — the processor
        // stops at a deleted `after` — and a later restore fans nothing out
        // either, because by then both sides of the restore carry the edit.
        // Consumers are left under the old name or encoding with nothing to
        // re-derive them. `parsePropertyDefinitionMetadata` is the existing
        // owner of that question, so it answers it here rather than a list of
        // states kept in step by hand.
        if (current === null || parsePropertyDefinitionMetadata(current) === null) return
        if (!stillCurrent(definitionFacts(current.properties))) return
        // From INSIDE the transaction, which is the only thing that makes a
        // progress report attributable: a run opens at the confirmation, and
        // a headless change to the same definition can hold the writer in
        // that gap. The writer is exclusive, so once this is set, whatever
        // reports next is this transaction's fan-out.
        markPropertyDefinitionFanoutRunning(workspaceId, block.id)
        await write(tx)
        guardPassed = true
      }, {scope: ChangeScope.BlockDefault, description: TX_DESCRIPTIONS[change.kind]})
      wrote = guardPassed
    } catch (error) {
      refused = true
      // `repo.tx` notifies the user-error channel before it rethrows, so a
      // rejection has already said why in the kernel's own words and ours
      // would only contradict it. Anything else has told nobody.
      if (!(error instanceof ProcessorRejection)) {
        console.error('[PropertySchemaContentRenderer] the change failed:', error)
        showError(`“${change.propertyName}” could not be changed. See the console.`)
      }
    } finally {
      run?.end()
    }
    if (!wrote && !refused) {
      showError(
        `“${change.propertyName}” changed somewhere else while you were deciding, `
        + 'so nothing was written. Take another look and try again.',
      )
    }
    return wrote
  }), [block, data])

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
  // SOMEBODY ELSE'S change, though, and `requestedName` is what tells them
  // apart. A rename is not instant — it is planned, counted, sometimes
  // confirmed, then committed — and the field is live throughout below the
  // threshold, so the user can be typing the next name when the last one
  // lands. Its own acknowledgement arriving then must not read as a remote
  // edit and take that typing away. The enum options editor learned the
  // same thing about its own writes (`pending`, there); both are working
  // around a seam that tells an editor nothing about its request, which is
  // what #1117 is for.
  const [draftName, setDraftName] = useState<string | null>(null)
  const [committedName, setCommittedName] = useState(propertyName)
  const [requestedName, setRequestedName] = useState<string | null>(null)
  if (propertyName !== committedName) {
    setCommittedName(propertyName)
    if (propertyName !== requestedName) setDraftName(null)
    setRequestedName(null)
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
    setRequestedName(next)
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
      setRequestedName(null)
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
          && sameConfig(now.config, atStart.config),
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
      if (atStart.presetId !== presetId || !sameConfig(atStart.config, persistedConfig)) {
        return {skip: OVERTAKEN(atStart.name)}
      }
      // Nothing to write, so nothing to ask about. Reachable without any
      // editing at all: the ref picker re-emits its list when a target type
      // already on it is entered again, and counting a whole graph to
      // confirm a write of the same bytes is the confirmation at its least
      // trustworthy.
      if (sameConfig(atStart.config, encoded)) return {skip: null}
      return {
        change: {kind: 'options', propertyName: atStart.name},
        stillCurrent: now => now.presetId === presetId
          && sameConfig(now.config, persistedConfig),
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
        <div className="relative max-w-xs">
          <select
            className="h-9 w-full appearance-none rounded-md border border-input bg-background px-2 pr-9 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            value={presetId}
            disabled={readOnly}
            // The gate owns the refusal now — it catches it, leaves the
            // kernel's own message standing, and reports a non-write to the
            // caller — so there is nothing left here to catch.
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
      </div>

      {preset?.ConfigEditor && (
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

      {!preset && presetId !== '' && (
        <div className="text-xs text-muted-foreground">
          The plugin contributing preset <code className="font-mono">{presetId}</code> is not loaded.
          Schemas using this preset stay registered when the plugin loads.
        </div>
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

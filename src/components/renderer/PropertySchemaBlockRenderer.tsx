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
  propertyValue,
  type AnyJoinedValuePreset,
  type Tx,
} from '@/data/api'
import { decodeRowProperty } from '@/data/rowProperty.js'
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
} from '@/data/propertyDefinitionFanout.js'
import {
  ConfirmDefinitionChangeDialog,
  type ConfirmDefinitionChangeDialogProps,
  type DefinitionChangeKind,
} from './ConfirmDefinitionChangeDialog.tsx'
import { showError } from '@/utils/toast.js'

/** The three bag keys this editor writes, read the ONE way.
 *
 *  Shared by the render and by the guard that re-reads the row inside the
 *  writing transaction: "what the user was shown" and "what is there now"
 *  have to be compared through the same decode, and they were three
 *  hand-copied decodes before this. `undefined` properties (no row yet) read
 *  as the defaults, which is what every one of those copies did. */
const definitionFacts = (properties: Record<string, unknown> | undefined) => {
  const row = {properties: properties ?? {}}
  return {
    name: decodeRowProperty(row, propertyNameProp),
    presetId: decodeRowProperty(row, presetIdProp),
    config: decodeRowProperty(row, presetConfigProp),
  }
}

type DefinitionFacts = ReturnType<typeof definitionFacts>

const TX_DESCRIPTIONS: Record<DefinitionChangeKind, string> = {
  rename: 'rename property',
  type: 'change property type',
  options: 'change property options',
}

const renderConfigEditor = (
  preset: AnyJoinedValuePreset,
  value: unknown,
  onChange: (next: unknown) => void,
): React.ReactNode => {
  if (!preset.ConfigEditor) return null
  const ConfigEditor = preset.ConfigEditor
  return <ConfigEditor value={value} onChange={onChange} />
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
   *  as long as the user is waiting on it, and write only if the definition is
   *  still the one they were shown.
   *
   *  The first two live here rather than in the processor that does the work:
   *  the count is a query the gesture can afford and the transaction cannot
   *  (it already holds the writer by then), and the wait the user is owed a
   *  surface for is the whole `repo.tx`, not the consumer loop inside it — the
   *  commit and the post-commit walk over every row it touched come after.
   *  One predicate (`isLargeFanout`) decides both, so a change can never ask
   *  and then run silently, or run for a minute without having asked.
   *
   *  The third is `stillAsShown`, checked INSIDE the writing transaction
   *  against a freshly read row. A confirmation is a human pause, and sync
   *  keeps running through it: without this, agreeing to "rename status to
   *  state" a moment after a peer renamed it performs "rename theirName to
   *  state" instead — the consent was about a definition that no longer
   *  exists, and the peer's edit is gone with no record. Each gesture supplies
   *  the one key it is REPLACING rather than comparing the whole row: a peer
   *  changing the type while this renames is not a reason to refuse the
   *  rename, and over-refusing costs the user a retry for nothing.
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
  const throughFanoutGate = useCallback(async (
    change: Omit<ConfirmDefinitionChangeDialogProps, 'blockCount'>,
    stillAsShown: (current: DefinitionFacts) => boolean,
    write: (tx: Tx) => Promise<void>,
  ): Promise<boolean> => {
    // The definition's OWN workspace, never the active one — this renderer is
    // mounted per block. With no row loaded there is nothing to scope the
    // count to, and no gesture either: every control below renders from `data`.
    const workspaceId = data?.workspaceId
    if (workspaceId === undefined) return false
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
      ? beginPropertyDefinitionFanout(workspaceId, change.propertyName, consumers)
      : null
    let wrote = false
    try {
      await block.repo.tx(async tx => {
        const current = await tx.get(block.id)
        if (current === null || !stillAsShown(definitionFacts(current.properties))) return
        await write(tx)
        wrote = true
      }, {scope: ChangeScope.BlockDefault, description: TX_DESCRIPTIONS[change.kind]})
    } finally {
      run?.end()
    }
    if (!wrote) {
      showError(
        `“${change.propertyName}” changed somewhere else while you were deciding, `
        + 'so nothing was written. Take another look and try again.',
      )
    }
    return wrote
  }, [block, data])

  const decodedConfig = useMemo<unknown>(() => {
    if (!preset?.configCodec) return undefined
    try {
      return preset.configCodec.decode(persistedConfig)
    } catch {
      return preset.defaultConfig
    }
  }, [persistedConfig, preset])

  // Render-phase resync via two pieces of derived state. When the
  // committed `propertyName` changes (remote edit, undo/redo, sync),
  // we adopt it as the draft in the same render — React supports
  // setState-during-render for this exact case. Focus is intentionally
  // not preserved: if a remote write lands mid-edit, accepting the
  // new committed name beats letting a stale draft overwrite it on
  // the next blur.
  const [draftName, setDraftName] = useState(propertyName)
  const [committedName, setCommittedName] = useState(propertyName)
  if (propertyName !== committedName) {
    setCommittedName(propertyName)
    setDraftName(propertyName)
  }

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
      setDraftName(propertyName)
      return
    }
    const wrote = await throughFanoutGate(
      {kind: 'rename', propertyName, nextName: next},
      current => current.name === propertyName,
      tx => tx.setProperty(block.id, propertyNameProp, next),
    )
    // A cancelled rename has to put the FIELD back too, not just decline the
    // write: the draft is what the user typed, and leaving it there shows a
    // name the definition does not have. Only on the decline — after a write
    // the resync above adopts the new committed name, and `propertyName` here
    // is the old one this closure captured.
    if (!wrote) setDraftName(propertyName)
  }, [block, propertyName, throughFanoutGate])

  const writePresetId = useCallback(async (next: string) => {
    if (next === presetId) return
    const target = presets.get(next)
    if (!target) return
    // setProperties applies a two-key DELTA read against the fresh in-tx row —
    // NOT a whole-bag replace off the (possibly stale) `data` render snapshot,
    // which would clobber any sibling key written between render and commit.
    await throughFanoutGate(
      {kind: 'type', propertyName},
      current => current.presetId === presetId,
      tx => tx.setProperties(block.id, {
        set: [
          propertyValue(presetIdProp, next),
          // Reset config to the new preset's defaultConfig (re-encoded through
          // its configCodec, if any), since the previous preset's config shape
          // doesn't apply.
          propertyValue(presetConfigProp, target.configCodec
            ? target.configCodec.encode(target.defaultConfig as never) as Record<string, unknown>
            : {}),
        ],
      }),
    )
  }, [block, presetId, presets, propertyName, throughFanoutGate])

  const writeConfig = useCallback(async (next: unknown) => {
    if (!preset?.configCodec) return
    let encoded: Record<string, unknown>
    try {
      encoded = preset.configCodec.encode(next as never) as Record<string, unknown>
    } catch (err) {
      console.warn(`[PropertySchemaContentRenderer] cannot encode config:`, err)
      return
    }
    await throughFanoutGate(
      {kind: 'options', propertyName},
      // A config write REPLACES the whole object, so a peer's edit to it is
      // what this would silently drop. Compared as stored text: both sides
      // come from the same round trip, and a re-ordering that is only
      // cosmetically different costs a retry, not a lost write.
      current => JSON.stringify(current.config) === JSON.stringify(persistedConfig),
      tx => tx.setProperty(block.id, presetConfigProp, encoded),
    )
  }, [block, persistedConfig, preset, propertyName, throughFanoutGate])

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
          value={draftName}
          placeholder="property name"
          disabled={readOnly}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDraftName(e.target.value)}
          onBlur={() => { void writeName(draftName) }}
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
            onChange={(e) => {
              // A refusal is already surfaced: `repo.tx` notifies the
              // user-error channel before it rethrows, and the toast layer
              // listens. Catching keeps the rethrow from becoming an unhandled
              // rejection — nothing here has anything to add to it. Routine
              // now that a re-type over values the new type cannot read is one
              // of the refusals (#1024).
              writePresetId(e.target.value).catch(() => {})
            }}
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
            {renderConfigEditor(preset, decodedConfig, writeConfig)}
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

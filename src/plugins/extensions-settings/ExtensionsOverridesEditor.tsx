/**
 * Property editor for `extensions:overrides`.
 *
 * Renders inside the property panel of the Extensions prefs
 * block. Composes:
 *   - `useToggleTree()` — walks the full extension tree (static +
 *     dynamic) into a discoverable forest
 *   - `<ExtensionsSettings>` — the presentational checkbox tree
 *   - `applyToggle` + `onChange` — the property-panel infrastructure
 *     handles the actual `tx.setProperty` write
 *
 * The block holds the canonical state; the sync effect mirrors each
 * change to the localStorage cache + dispatches `refreshAppRuntime`
 * so all consumers of the runtime see the toggle take effect.
 */

import {useCallback} from 'react'
import type {PropertyEditorProps} from '@/data/api'
import {applyToggle, type Overrides, type Togglable} from '@/facets/togglable.js'
import {ExtensionsSettings} from './ExtensionsSettings.tsx'
import {useToggleTree} from './useToggleTree.ts'

export const ExtensionsOverridesEditor = ({
  value,
  onChange,
}: PropertyEditorProps<Overrides>) => {
  const {tree, loading, workspaceId} = useToggleTree()

  const handleToggle = useCallback(
    (handle: Togglable, nextState: boolean) => {
      onChange(applyToggle(value, handle, nextState))
    },
    [onChange, value],
  )

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading extensions…</p>
  }

  return (
    <ExtensionsSettings
      tree={tree}
      overrides={value}
      onToggle={handleToggle}
      workspaceId={workspaceId}
    />
  )
}

/**
 * Presentational tree of toggle rows for the System Plugins settings
 * surface.
 *
 * Pure: takes a discovered `ToggleNode[]` + the current `Overrides`
 * map + an `onToggle(handle, next)` callback, and renders nested
 * checkboxes. The caller threads `onToggle` into a write to the
 * System Plugins block (see `setOverride`, slice 9c).
 *
 * Conventions:
 *
 *   - Each row is a checkbox + label + (optional) description.
 *   - Essentials render as `checked` and `disabled` — they cannot be
 *     flipped through the UI (the `isEnabled` filter forces them on
 *     anyway, so a flippable checkbox would only confuse).
 *   - Children indent one level via padding; ARIA `treeitem` /
 *     `aria-level` carries the nesting for assistive tech and tests.
 */

import {Fragment} from 'react'
import {Checkbox} from '@/components/ui/checkbox.tsx'
import {Label} from '@/components/ui/label.tsx'
import type {ToggleNode} from '@/extensions/discoverToggleTree.ts'
import {isEnabled, type Overrides, type Togglable} from '@/extensions/togglable.ts'

export interface SystemPluginsSettingsProps {
  tree: ReadonlyArray<ToggleNode>
  overrides: Overrides
  onToggle: (handle: Togglable, nextState: boolean) => void
}

export const SystemPluginsSettings = ({
  tree,
  overrides,
  onToggle,
}: SystemPluginsSettingsProps) => {
  if (tree.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No plugins to display.
      </p>
    )
  }

  return (
    <ul role="tree" className="flex flex-col gap-1">
      {tree.map(node => (
        <ToggleRow
          key={node.handle.id}
          node={node}
          overrides={overrides}
          onToggle={onToggle}
          level={1}
        />
      ))}
    </ul>
  )
}

interface ToggleRowProps {
  node: ToggleNode
  overrides: Overrides
  onToggle: (handle: Togglable, nextState: boolean) => void
  level: number
}

const ToggleRow = ({node, overrides, onToggle, level}: ToggleRowProps) => {
  const {handle, children} = node
  const checked = isEnabled(handle, overrides)
  const essential = handle.essential === true
  const checkboxId = `system-plugin-toggle-${handle.id}`
  // Pad inward per level; level 1 stays flush so the outer row aligns
  // with the parent container.
  const indent = (level - 1) * 16

  return (
    <Fragment>
      <li
        role="treeitem"
        aria-level={level}
        aria-checked={checked}
        aria-label={handle.name}
        className="flex items-start gap-2"
        style={{paddingInlineStart: indent}}
      >
        <Checkbox
          id={checkboxId}
          checked={checked}
          disabled={essential}
          onCheckedChange={(next) => {
            if (essential) return
            onToggle(handle, next === true)
          }}
        />
        <div className="flex flex-col">
          <Label
            htmlFor={checkboxId}
            className={essential ? 'text-muted-foreground' : undefined}
          >
            {handle.name}
            {essential && (
              <span className="ml-2 text-xs text-muted-foreground">
                (essential)
              </span>
            )}
          </Label>
          {handle.description && (
            <span className="text-xs text-muted-foreground">
              {handle.description}
            </span>
          )}
        </div>
      </li>
      {children.length > 0 && children.map(child => (
        <ToggleRow
          key={child.handle.id}
          node={child}
          overrides={overrides}
          onToggle={onToggle}
          level={level + 1}
        />
      ))}
    </Fragment>
  )
}

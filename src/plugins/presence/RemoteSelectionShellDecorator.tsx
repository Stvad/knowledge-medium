/**
 * Paints a coloured ring around any block a remote peer has selected /
 * focused / is editing. Contributed to `blockShellDecoratorsFacet`, so it
 * composes with the local focus highlight rather than replacing it.
 *
 * The ring colour is per-peer and dynamic, which Tailwind classes can't
 * express, so we set `box-shadow` directly on the shell node via `shellRef`.
 * Stacked `inset` rings (2px, 4px, …) show multiple peers on one block. This
 * is a property React never sets on the shell, so the write survives
 * re-renders; the effect clears it on change/unmount.
 */
import { useLayoutEffect } from 'react'
import type {
  BlockShellDecoratorContribution,
  BlockShellDecoratorProps,
} from '@/extensions/blockInteraction.js'
import { useRemoteSelectionColorKey } from './hooks.js'

export function RemoteSelectionShellDecorator({
  resolveContext,
  shellRef,
  state,
  children,
}: BlockShellDecoratorProps) {
  const colorKey = useRemoteSelectionColorKey(resolveContext.block.id)

  useLayoutEffect(() => {
    const el = shellRef.current
    if (!el) return
    if (!colorKey) {
      el.style.boxShadow = ''
      return
    }
    el.style.boxShadow = colorKey
      .split(',')
      .map((color, i) => `inset 0 0 0 ${2 * (i + 1)}px ${color}`)
      .join(', ')
    return () => {
      const node = shellRef.current
      if (node) node.style.boxShadow = ''
    }
  }, [colorKey, shellRef])

  return <>{children(state)}</>
}

export const remoteSelectionShellDecorator: BlockShellDecoratorContribution = () =>
  RemoteSelectionShellDecorator

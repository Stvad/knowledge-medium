import { createContext, useContext, useMemo } from 'react'
import { shortcutSurfaceActivationsFacet } from '@/extensions/blockInteraction.ts'
import type {
  BlockInteractionContext,
  ShortcutSurface,
  ShortcutSurfaceContext,
} from '@/extensions/blockInteraction.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { useActionContextActivations } from '@/shortcuts/useActionContext.ts'

export const ReactBlockInteractionContext = createContext<BlockInteractionContext | null>(null)

export const useBlockInteractionContext = () =>
  useContext(ReactBlockInteractionContext)

type ShortcutSurfaceOptions =
  Partial<Omit<ShortcutSurfaceContext, keyof BlockInteractionContext | 'surface'>> &
  Record<string, unknown>

const emptyShortcutSurfaceOptions: ShortcutSurfaceOptions = {}

export function useShortcutSurfaceActivations(
  surface: ShortcutSurface,
  options: ShortcutSurfaceOptions = emptyShortcutSurfaceOptions,
): void {
  const context = useBlockInteractionContext()
  const runtime = useAppRuntime()
  const resolveShortcutActivations = runtime.read(shortcutSurfaceActivationsFacet)
  const shortcutActivations = useMemo(
    () => context
      ? resolveShortcutActivations({
        ...context,
        ...options,
        surface,
      })
      : [],
    [context, options, resolveShortcutActivations, surface],
  )

  useActionContextActivations(shortcutActivations)
}

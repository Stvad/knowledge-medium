/**
 * Opens the Supabase Realtime presence channel for the active workspace and
 * tears it down on workspace change / extension disable. A module-scope
 * constant (not an inline object) so the effect reconciler treats it as a
 * stable identity and only restarts it when `repo` / `workspaceId` actually
 * change — see the `AppEffect` lifecycle contract in `extensions/core.ts`.
 */
import type { AppEffect } from '@/extensions/core.js'
import { presenceClient } from './presenceClient.js'

export const presenceAppEffect: AppEffect = {
  id: 'presence.channel',
  start: ({ repo, workspaceId }) => {
    presenceClient.connect({ workspaceId, user: repo.user })
    return () => presenceClient.disconnect()
  },
}

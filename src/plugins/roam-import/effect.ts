import type { AppEffect } from '@/extensions/core.ts'
import { ensureRoamImportWindowHook } from './runtime.ts'

/** Installs `window.__omniliner.roamImport` once per Repo so the agent
 *  runtime / devtools console can kick off an import without the file
 *  picker. `ensureRoamImportWindowHook` is idempotent — the AppEffect
 *  surface re-runs across plugin reloads without leaking handlers. */
export const roamImportWindowHookEffect: AppEffect = {
  id: 'roam-import.window-hook',
  start: ({repo}) => {
    ensureRoamImportWindowHook(repo)
  },
}

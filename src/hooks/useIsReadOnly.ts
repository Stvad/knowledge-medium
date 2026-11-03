import { useCallback, useSyncExternalStore } from 'react'
import type { Repo } from '@/data/repo'

/** `repo.isReadOnly`, re-rendering when it changes. A role change arrives
 *  from the server and moves nothing else, so a component reading the
 *  field directly keeps the permissions it first rendered with. */
export const useIsReadOnly = (repo: Repo): boolean =>
  useSyncExternalStore(
    useCallback((onChange: () => void) => repo.onReadOnlyChange(onChange), [repo]),
    () => repo.isReadOnly,
  )

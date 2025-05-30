import { useSyncExternalStore, useCallback, useMemo } from 'react'
// import { AnyDocumentId, Doc, ChangeFn, ChangeOptions, DocHandle } from 'downflow'
import { AnyDocumentId, Doc, DocHandle } from '@automerge/automerge-repo'
import { ChangeFn, ChangeOptions } from '@automerge/automerge'
import { useRepo } from '@automerge/automerge-repo-react-hooks'

/**
 * A version of useDocument that accepts a selector and renders only if that part of tho doc was updated
 * @param id    The document ID
 * @param selector  Function extracting the slice you care about
 * @returns A tuple [selectedSlice, changeDoc]
 */
export function useDocumentWithSelector<T, U>(
  id: AnyDocumentId | undefined,
  selector: (doc: Doc<T> | undefined) => U
): [U, (changeFn: ChangeFn<T>, options?: ChangeOptions<T>) => void] {
  const repo = useRepo()

  // Memoize the handle so it doesn't change identity unless id or repo changes
  const handle = useMemo<DocHandle<T> | null>(
    () => (id ? repo.find<T>(id) : null),
    [id, repo]
  )  // useMemo caches handle identity  [oai_citation:2‡React](https://react.dev/reference/react/useMemo?utm_source=chatgpt.com)

  // Subscribe callback for useSyncExternalStore
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!handle) return () => {}
      handle.on('change', onStoreChange)
      handle.on('delete', onStoreChange)
      return () => {
        handle.removeListener('change', onStoreChange)
        handle.removeListener('delete', onStoreChange)
      }
    },
    [handle]
  )  // useCallback stabilizes subscribe  [oai_citation:3‡React](https://react.dev/reference/react/useCallback?utm_source=chatgpt.com)

  // Snapshot pulling only the selected slice
  const getSnapshot = useCallback((): U => {
    const doc = handle?.docSync()
    return selector(doc)
  }, [handle, selector])

  // useSyncExternalStore bails out on Object.is equality of snapshots  [oai_citation:4‡React](https://react.dev/reference/react/useSyncExternalStore?utm_source=chatgpt.com) [oai_citation:5‡GitHub](https://github.com/facebook/react/issues/24884?utm_source=chatgpt.com)
  const selected = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // Change function (stable via useCallback)
  const changeDoc = useCallback(
    (changeFn: ChangeFn<T>, options?: ChangeOptions<T>) => {
      handle?.change(changeFn, options)
    },
    [handle]
  )  // caching setter identity  [oai_citation:6‡React](https://react.dev/reference/react/useCallback?utm_source=chatgpt.com)

  return [selected, changeDoc]
}

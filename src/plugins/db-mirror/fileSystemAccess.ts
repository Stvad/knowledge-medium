/**
 * The File System Access API surface this plugin needs, typed here because
 * `lib.dom` carries only the standardised half — `getFileHandle`, `removeEntry`
 * and `createWritable` are declared, while the directory picker and the
 * per-handle permission methods are not. Same approach as the manual export's
 * `showSaveFilePicker` declaration in `@/utils/exportSqliteDb`.
 */

export type FileSystemPermissionMode = 'read' | 'readwrite'

interface HandlePermissions {
  queryPermission?: (descriptor?: {mode?: FileSystemPermissionMode}) => Promise<PermissionState>
  requestPermission?: (descriptor?: {mode?: FileSystemPermissionMode}) => Promise<PermissionState>
}

type WindowWithDirectoryPicker = typeof globalThis & {
  showDirectoryPicker?: (options?: {
    id?: string
    mode?: FileSystemPermissionMode
    startIn?: string
  }) => Promise<FileSystemDirectoryHandle>
}

/** Whether this browser can offer the feature at all. Firefox and Safari have
 *  no directory picker, so the setting is never shown there. */
export const supportsDirectoryMirroring = (): boolean =>
  typeof (globalThis as WindowWithDirectoryPicker).showDirectoryPicker === 'function'

/** Ask the user for a folder. MUST be called from a user gesture. Resolves to
 *  undefined when the browser has no picker; rejects with an `AbortError` when
 *  the user dismisses it. */
export const chooseMirrorDirectory = async (): Promise<FileSystemDirectoryHandle | undefined> => {
  const picker = (globalThis as WindowWithDirectoryPicker).showDirectoryPicker
  if (!picker) return undefined
  return picker({id: 'km-db-mirror', mode: 'readwrite'})
}

/** The standing grant on a stored handle. Never prompts.
 *
 *  A handle from a browser without the permission methods can only have come
 *  from a picker in this same session, so "granted" is the honest answer there;
 *  a real write failure surfaces on its own. */
export const queryDirectoryPermission = async (
  directory: FileSystemDirectoryHandle,
): Promise<PermissionState> => {
  const query = (directory as unknown as HandlePermissions).queryPermission
  if (typeof query !== 'function') return 'granted'
  return query.call(directory, {mode: 'readwrite'})
}

/** Re-ask for a grant that lapsed. MUST be called from a user gesture — the
 *  browser silently denies it otherwise, which is why no scheduled run calls
 *  this. */
export const requestDirectoryPermission = async (
  directory: FileSystemDirectoryHandle,
): Promise<PermissionState> => {
  const request = (directory as unknown as HandlePermissions).requestPermission
  if (typeof request !== 'function') return 'granted'
  return request.call(directory, {mode: 'readwrite'})
}

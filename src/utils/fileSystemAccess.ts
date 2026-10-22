/**
 * The File System Access API's directory half, typed here because `lib.dom`
 * carries only the standardised part — `getFileHandle`, `removeEntry` and
 * `createWritable` are declared, while the directory picker and the
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

/** Firefox and Safari have no directory picker. */
export const supportsDirectoryPicker = (): boolean =>
  typeof (globalThis as WindowWithDirectoryPicker).showDirectoryPicker === 'function'

/** Ask the user for a folder. MUST be called from a user gesture. Resolves to
 *  undefined when the browser has no picker; rejects with an `AbortError` when
 *  the user dismisses it. `id` makes the picker reopen where it was last used. */
export const pickDirectory = async (
  options: {readonly id: string; readonly mode: FileSystemPermissionMode},
): Promise<FileSystemDirectoryHandle | undefined> => {
  const picker = (globalThis as WindowWithDirectoryPicker).showDirectoryPicker
  if (!picker) return undefined
  return picker({id: options.id, mode: options.mode})
}

/** A dismissed picker or permission prompt: not a failure worth reporting. */
export const isPickerDismissal = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError'

/** The standing grant on a stored handle. Never prompts.
 *
 *  The `typeof` fallback is DEFENCE IN DEPTH and unpinned, and it fails OPEN on
 *  purpose: a handle from a browser without the permission methods can only
 *  have come from a picker in this same session, so "granted" is the honest
 *  answer, and a real read or write failure surfaces on its own. */
export const queryDirectoryPermission = async (
  directory: FileSystemDirectoryHandle,
  mode: FileSystemPermissionMode,
): Promise<PermissionState> => {
  const query = (directory as unknown as HandlePermissions).queryPermission
  if (typeof query !== 'function') return 'granted'
  return query.call(directory, {mode})
}

/** Re-ask for a grant that lapsed. MUST be called from a user gesture — the
 *  browser silently denies it otherwise. */
export const requestDirectoryPermission = async (
  directory: FileSystemDirectoryHandle,
  mode: FileSystemPermissionMode,
): Promise<PermissionState> => {
  const request = (directory as unknown as HandlePermissions).requestPermission
  if (typeof request !== 'function') return 'granted'
  return request.call(directory, {mode})
}

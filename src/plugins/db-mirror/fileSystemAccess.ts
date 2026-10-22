/**
 * The mirror's use of the File System Access API (`@/utils/fileSystemAccess`):
 * always read-write, since a read grant hands back a handle that looks fine and
 * fails on every write, and its own picker id so the picker reopens where the
 * mirror folder was chosen.
 */

import {
  pickDirectory,
  queryDirectoryPermission as queryPermission,
  requestDirectoryPermission as requestPermission,
  supportsDirectoryPicker,
} from '@/utils/fileSystemAccess.js'

/** Whether this browser can offer the feature at all. Firefox and Safari have
 *  no directory picker, so the setting is never shown there. */
export const supportsDirectoryMirroring = supportsDirectoryPicker

/** MUST be called from a user gesture; see {@link pickDirectory}. */
export const chooseMirrorDirectory = (): Promise<FileSystemDirectoryHandle | undefined> =>
  pickDirectory({id: 'km-db-mirror', mode: 'readwrite'})

export const queryDirectoryPermission = (directory: FileSystemDirectoryHandle): Promise<PermissionState> =>
  queryPermission(directory, 'readwrite')

/** MUST be called from a user gesture. */
export const requestDirectoryPermission = (directory: FileSystemDirectoryHandle): Promise<PermissionState> =>
  requestPermission(directory, 'readwrite')

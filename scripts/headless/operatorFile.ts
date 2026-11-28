import {open} from 'node:fs/promises'

export class OperatorFilePermissionsError extends Error {}

/** Check the opened file so the permission check and read refer to the same inode. */
export async function readOperatorFile(
  file: string, kind: 'config' | 'reviewed',
): Promise<string> {
  const handle = await open(file, 'r').catch(() => {
    throw new Error(`${kind}-file-unreadable`)
  })
  try {
    const {uid, mode} = await handle.stat()
    if (uid !== process.geteuid!() || (mode & 0o022) !== 0) {
      throw new OperatorFilePermissionsError(`${kind}-file-permissions`)
    }
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}
